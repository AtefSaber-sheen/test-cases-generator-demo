// The closure walk: from a scope, everything that scope can reach.
//
// THE PROBLEM THIS SOLVES. Point the pipeline at `src/checkout` and a naive scope filter inventories
// the four files in that directory. But the checkout controller calls PromoService, which calls a
// promotion repository, which calls the ORM; it reads a feature flag; it publishes an event. Test
// those callees as black boxes and the suite covers one layer of a five-layer execution path: it
// passes while the regression ships in the layer below.
//
// So the scope is a SEED, not a boundary. From the seed files this walks every import edge that
// resolves inside the repository, transitively, and the resulting set is the code whose behaviour
// the part under test actually depends on. That set is what Stage 2 reads and Stage 3 covers.
//
// DIRECTION MATTERS, AND BOTH DIRECTIONS ARE NEEDED.
//
//   DOWNSTREAM (callees) answers: what does my code execute? Every rule on those paths is a rule
//   the part under test can violate, so these become in-scope behaviour.
//
//   UPSTREAM (callers) answers: who executes my code? This is blast radius. A change to a shared
//   validator in the seed breaks callers the seed never mentions, and a suite that ignores them
//   reports green while the regression ships. Upstream files are recorded as IMPACTED: their own
//   callees are not pulled in, because that would walk the entire repository in two hops.
//
// DEPTH IS REPORTED, NEVER SILENTLY APPLIED. A depth limit is a statement about how much of the
// execution path was examined. When the walk stops at the limit with frontier files still
// unexplored, those files are listed: a closure that was truncated must not read as complete.

'use strict';

const { extractEdges } = require('./edges');
const { buildResolveContext, resolveWithContext } = require('./resolve');

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_FILES = 4000;

/** Normalise a user-supplied path to the repo-relative POSIX form used throughout. */
function normPath(value) {
  return String(value)
    .split('\\').join('/')
    .replace(/^\.\//, '')
    .replace(/\/$/, '');
}

// ---------------------------------------------------------------------------
// Scope selection
// ---------------------------------------------------------------------------

/**
 * Select the seed files a scope names.
 *
 * Three shapes are supported, matching the scope vocabulary Stage 1 already documents:
 *   - 'full-repo'   every source file in the repository
 *   - a path       every file at or under it ('src/checkout', 'apps/api')
 *   - a file list  an explicit set, which is what a diff scope resolves to
 *
 * A scope that selects NOTHING is reported with its own flag rather than run as an empty closure:
 * it almost always means a mistyped path, and an empty result that reads as success is the worst
 * available answer.
 */
function selectSeeds(files, scope) {
  if (!scope || scope === 'full-repo' || scope === '.') {
    return { seeds: [...files], kind: 'full-repo', spec: 'full-repo', missing: [] };
  }

  if (Array.isArray(scope)) {
    const wanted = scope.map(normPath);
    const present = new Set(files);
    const seeds = wanted.filter((w) => present.has(w));
    const missing = wanted.filter((w) => !present.has(w));
    return { seeds, kind: 'file-list', spec: wanted.join(', '), missing };
  }

  const norm = normPath(scope);
  const seeds = files.filter((f) => f === norm || f.startsWith(norm + '/'));
  return { seeds, kind: 'path', spec: norm, missing: [] };
}
// ---------------------------------------------------------------------------
// Attributing a call site to the import that supplies it
// ---------------------------------------------------------------------------

/**
 * Build a function that returns the call sites belonging to a given import.
 *
 * Three routes from a call to its import, tried in order of how much they prove:
 *
 *   1. The call head IS an imported binding.        `PromoService.create()`, `axios.post()`
 *   2. The invoked method IS an imported binding.   `validate()` from a named import
 *   3. The call head is a FIELD whose declared type is an imported binding. This is the
 *      dependency-injection case, and without it the whole DI-shaped half of the server world
 *      produces edges with no call sites - the import looks unused and the line a test must
 *      drive is never recorded.
 *
 * A call matched by none of the three is left unattributed rather than assigned to the likeliest
 * import. Wrongly attributing a call site puts a failure-injection point on a dependency that
 * cannot produce it, which costs more than the missing row.
 */
function attributionFor(info) {
  const byBinding = new Map();
  for (const imp of info.imports) {
    for (const b of imp.bindings) byBinding.set(b, imp);
  }

  const fieldTypes = info.fieldTypes || {};

  const importFor = (call) => {
    if (byBinding.has(call.head)) return byBinding.get(call.head);
    if (byBinding.has(call.method)) return byBinding.get(call.method);
    const declaredType = fieldTypes[call.head];
    if (declaredType && byBinding.has(declaredType)) return byBinding.get(declaredType);
    return null;
  };

  const grouped = new Map();
  for (const call of info.calls) {
    const imp = importFor(call);
    if (!imp) continue;
    if (!grouped.has(imp)) grouped.set(imp, []);
    grouped.get(imp).push(call);
  }

  return (imp) => grouped.get(imp) || [];
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

/**
 * Walk the dependency graph from a scope.
 *
 * @param {object} args
 * @param {string} args.root      repository root (absolute)
 * @param {string[]} args.files   every repo-relative source file (from the recon census)
 * @param {string|string[]} [args.scope]  'full-repo', a path, or a file list
 * @param {number} [args.maxDepth]  how many hops of callees to follow
 * @param {number} [args.maxFiles]  hard cap on files examined, so a pathological repo terminates
 * @param {boolean} [args.upstream] also find the callers of the seed (blast radius)
 * @returns {object} the closure report
 */
function walkClosure(args) {
  const root = args.root;
  const files = args.files || [];
  const maxDepth = Number.isFinite(args.maxDepth) ? args.maxDepth : DEFAULT_MAX_DEPTH;
  const maxFiles = Number.isFinite(args.maxFiles) ? args.maxFiles : DEFAULT_MAX_FILES;
  const wantUpstream = args.upstream !== false;

  const ctx = buildResolveContext(root, files);
  const scope = selectSeeds(files, args.scope);

  // depth 0 = the seed itself. A file is recorded at the SHALLOWEST depth it is reached by,
  // because that is the shortest execution path from the part under test to it - which is what
  // decides how directly a test can drive it.
  const depthOf = new Map();
  const edges = [];
  const externals = new Map();
  const unresolved = [];
  const skippedFiles = [];
  const extractCache = new Map();

  const extract = (file) => {
    if (extractCache.has(file)) return extractCache.get(file);
    const result = extractEdges(root, file);
    extractCache.set(file, result);
    if (result.skipped) skippedFiles.push({ file, reason: result.skipped });
    return result;
  };

  for (const seed of scope.seeds) depthOf.set(seed, 0);

  let frontier = [...scope.seeds];
  let depth = 0;
  let truncatedAtDepth = null;
  let truncatedFrontier = [];
  let cappedAtFiles = false;

  while (frontier.length) {
    if (depth >= maxDepth) {
      truncatedAtDepth = depth;
      truncatedFrontier = [...frontier];
      break;
    }
    const next = [];

    for (const file of frontier) {
      const info = extract(file);

      const attribute = attributionFor(info);

      for (const imp of info.imports) {
        // Call sites that this import supplies. An import with none is a dependency no path uses.
        const sites = attribute(imp).map((c) => ({
          ref: c.ref,
          symbol: (c.receiver ? c.receiver + '.' : '') + c.method,
          line: c.line,
        }));

        if (imp.specifier === null) {
          unresolved.push({
            from: file,
            specifier: null,
            ref: imp.ref,
            reason: 'the import target is computed at runtime and is not stated in source',
            snippet: imp.snippet,
          });
          continue;
        }

        const res = resolveWithContext(ctx, file, imp.specifier);

        if (res.status === 'internal') {
          edges.push({
            from: file,
            to: res.target,
            specifier: imp.specifier,
            kind: imp.kind,
            via: res.via,
            ref: imp.ref,
            callSites: sites,
          });
          if (!depthOf.has(res.target)) {
            if (depthOf.size >= maxFiles) { cappedAtFiles = true; continue; }
            depthOf.set(res.target, depth + 1);
            next.push(res.target);
          }
          continue;
        }

        if (res.status === 'external') {
          const key = imp.specifier;
          const prev = externals.get(key) || { specifier: key, importedBy: [], callSites: [], reason: res.reason };
          if (!prev.importedBy.includes(file)) prev.importedBy.push(file);
          for (const s of sites) prev.callSites.push({ ...s, file });
          externals.set(key, prev);
          continue;
        }

        unresolved.push({
          from: file,
          ref: imp.ref,
          specifier: imp.specifier,
          reason: res.reason || 'could not be resolved',
          snippet: imp.snippet,
        });
      }
    }

    frontier = next;
    depth += 1;
  }
  // -------------------------------------------------------------------------
  // Upstream: who calls into the closure?
  // -------------------------------------------------------------------------
  //
  // This is blast radius, and it is the half a scope filter always misses. Every file OUTSIDE the
  // closure is examined for an import that lands INSIDE it. Those files are impacted by a change
  // to the part under test even though the scope never named them.
  //
  // Their own dependencies are deliberately NOT followed. One hop is the useful signal; two hops
  // reaches most of a connected repository and stops being information.
  const impacted = [];
  if (wantUpstream) {
    const inClosure = new Set(depthOf.keys());
    for (const file of files) {
      if (inClosure.has(file)) continue;
      const info = extract(file);
      if (!info.imports.length) continue;

      const attribute = attributionFor(info);


      const reaches = [];
      for (const imp of info.imports) {
        if (imp.specifier === null) continue;
        const res = resolveWithContext(ctx, file, imp.specifier);
        if (res.status !== 'internal' || !inClosure.has(res.target)) continue;
        const sites = attribute(imp).map((c) => ({
          ref: c.ref,
          symbol: (c.receiver ? c.receiver + '.' : '') + c.method,
        }));
        reaches.push({ target: res.target, specifier: imp.specifier, ref: imp.ref, callSites: sites });
      }
      if (reaches.length) impacted.push({ file, reaches });
    }
  }

  // -------------------------------------------------------------------------
  // Report
  // -------------------------------------------------------------------------
  const byDepth = new Map();
  for (const [file, d] of depthOf) {
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d).push(file);
  }
  for (const list of byDepth.values()) list.sort();

  const reachedFiles = [...depthOf.keys()].sort();
  const seedSet = new Set(scope.seeds);

  return {
    closureVersion: '1.0',
    root,
    scope: {
      kind: scope.kind,
      spec: scope.spec,
      seedCount: scope.seeds.length,
      seeds: [...scope.seeds].sort(),
      missing: scope.missing || [],
      selectedNothing: scope.seeds.length === 0,
    },
    limits: {
      maxDepth,
      maxFiles,
      upstream: wantUpstream,
      depthReached: Math.max(0, ...[...depthOf.values()]),
    },
    reached: {
      total: reachedFiles.length,
      seeds: scope.seeds.length,
      pulledIn: reachedFiles.filter((f) => !seedSet.has(f)).length,
      files: reachedFiles.map((f) => ({ file: f, depth: depthOf.get(f), seed: seedSet.has(f) })),
      byDepth: [...byDepth.entries()].sort((a, b) => a[0] - b[0]).map(([d, list]) => ({ depth: d, count: list.length, files: list })),
    },
    internalEdges: edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
    externalBoundaries: [...externals.values()].sort((a, b) => b.callSites.length - a.callSites.length || a.specifier.localeCompare(b.specifier)),
    impactedByChange: impacted.sort((a, b) => a.file.localeCompare(b.file)),
    unresolvedEdges: unresolved,
    incomplete: {
      truncatedAtDepth,
      truncatedFrontier: truncatedFrontier.sort(),
      cappedAtFiles,
      skippedFiles,
      // The single question a reader of this report must be able to answer without reading code.
      isComplete: truncatedAtDepth === null && !cappedAtFiles && unresolved.length === 0
        && skippedFiles.length === 0,
    },
    disclaimer:
      'Edges are resolved from import syntax and call-site text, not from a type checker. An '
      + 'edge created by dependency injection, reflection, a service locator or a computed '
      + 'import cannot be seen this way; unresolvedEdges lists every place one is known to '
      + 'exist. Treat the closure as a floor on what the scope reaches, never a ceiling.',
  };
}

module.exports = { walkClosure, selectSeeds, normPath, DEFAULT_MAX_DEPTH, DEFAULT_MAX_FILES };
