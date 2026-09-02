// Static inventory of a codebase — the factual base the recon skill starts from.
//
// WHAT IT PRODUCES: a manifest-derived stack profile, a file census, candidate testable surfaces
// with `path:line` for each, and a list of the tests that already exist. Nothing here is a test
// case, and nothing here is a conclusion. It answers "where should I look, and have I looked
// everywhere?" so that the reading which follows is exhaustive rather than opportunistic.
//
// WHY A TOOL AND NOT JUST GREP. Three reasons, all about completeness. A person greps for the
// surfaces they already suspect; the table sweeps every ecosystem this package knows. A person's
// grep output has no denominator, so "I found 40 routes" cannot be checked against "how many files
// were even searched"; this reports both. And a person's grep silently skips the 2 MB generated
// client and the vendored directory without saying so; every skip here is counted and reported.
//
// NO SILENT CAPS. Where a limit truncates output, the report says what was dropped and why. A
// truncated list that reads as complete is worse than no list.

'use strict';

const fs = require('fs');
const path = require('path');

const {
  MANIFESTS,
  STACK_SIGNALS,
  DETECTORS,
  IGNORED_DIRS,
  IGNORED_FILE,
  TEST_PATH,
  SCHEMA_PATH,
} = require('./detectors');

const DEFAULT_MAX_FILE_BYTES = 1_500_000;
const DEFAULT_MAX_HITS_PER_DETECTOR = 300;
const SNIPPET_LIMIT = 180;

/** Read `.gitignore` well enough to skip the directories teams actually put in it. */
function readGitignoreDirs(root) {
  const file = path.join(root, '.gitignore');
  if (!fs.existsSync(file)) return new Set();
  const dirs = new Set();
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    // Only simple directory entries are honoured. Full gitignore semantics (globs, negation,
    // nesting) are deliberately out of scope: a scanner that half-implements them skips files the
    // user expected to be scanned, which is the one failure mode that matters here.
    if (/[*?[\]]/.test(line)) continue;
    dirs.add(line.replace(/^\//, '').replace(/\/$/, ''));
  }
  return dirs;
}

function extensionOf(file) {
  const lower = file.toLowerCase();
  if (lower.endsWith('.blade.php')) return '.blade.php';
  const ext = path.extname(lower);
  return ext || '(none)';
}

/**
 * Walk the tree, collecting relative paths.
 * @returns {{files: string[], skipped: object, dirCount: number}}
 */
function walk(root, options) {
  const opts = options || {};
  const extraIgnores = opts.ignoreDirs || new Set();
  const maxBytes = opts.maxFileBytes || DEFAULT_MAX_FILE_BYTES;

  const files = [];
  const skipped = { ignoredDirs: [], binaryOrAsset: 0, tooLarge: [], unreadable: [] };
  let dirCount = 0;

  const visit = (absDir) => {
    dirCount += 1;
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (err) {
      skipped.unreadable.push({ path: path.relative(root, absDir), reason: err.code || err.message });
      return;
    }

    for (const entry of entries) {
      const abs = path.join(absDir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');

      if (entry.isSymbolicLink()) continue; // a symlink can loop, and never adds a new file
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || extraIgnores.has(entry.name) || extraIgnores.has(rel)) {
          skipped.ignoredDirs.push(rel);
          continue;
        }
        visit(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (IGNORED_FILE.test(entry.name)) { skipped.binaryOrAsset += 1; continue; }

      let stat;
      try {
        stat = fs.statSync(abs);
      } catch (err) {
        skipped.unreadable.push({ path: rel, reason: err.code || err.message });
        continue;
      }
      if (stat.size > maxBytes) {
        skipped.tooLarge.push({ path: rel, bytes: stat.size });
        continue;
      }
      files.push(rel);
    }
  };

  visit(root);
  return { files, skipped, dirCount };
}

/** Which detectors apply to a given file extension. */
function detectorsFor(ext) {
  return DETECTORS.filter((d) => d.ext.includes(ext));
}

/**
 * Infer module boundaries from directory layout.
 *
 * A "module" here is just a grouping the test suite can be organised by. Monorepo conventions
 * (`apps/`, `packages/`, `services/`) name them explicitly; otherwise the first directory under a
 * source root is the best available guess. It is a STARTING POINT the recon skill confirms or
 * overrides — never a claim about the system's real architecture.
 */
function inferModules(files) {
  const containers = ['apps', 'packages', 'services', 'modules', 'libs', 'projects'];
  const counts = new Map();

  for (const file of files) {
    const parts = file.split('/');
    let name = null;

    const containerIndex = parts.findIndex((p) => containers.includes(p.toLowerCase()));
    if (containerIndex !== -1 && parts.length > containerIndex + 1) {
      name = parts.slice(0, containerIndex + 2).join('/');
    } else if (parts.length > 2 && ['src', 'app', 'lib', 'internal', 'pkg'].includes(parts[0])) {
      name = parts.slice(0, 2).join('/');
    } else if (parts.length > 1) {
      name = parts[0];
    }

    if (!name) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }

  return [...counts.entries()]
    .map(([name, fileCount]) => ({ name, fileCount }))
    .filter((m) => m.fileCount >= 2)
    .sort((a, b) => b.fileCount - a.fileCount);
}

function detectStack(root, files) {
  const found = [];
  const dependencies = new Set();
  const ecosystems = new Set();

  for (const manifest of MANIFESTS) {
    const matches = files.filter((f) => path.basename(f) === manifest.file);
    for (const rel of matches) {
      let text;
      try {
        text = fs.readFileSync(path.join(root, rel), 'utf8');
      } catch {
        continue;
      }
      ecosystems.add(manifest.ecosystem);
      const deps = manifest.extract(text) || [];
      for (const dep of deps) dependencies.add(dep);
      found.push({ manifest: rel, ecosystem: manifest.ecosystem, dependencyCount: deps.length });
    }
  }

  const signals = [];
  for (const signal of STACK_SIGNALS) {
    const hits = [...dependencies].filter((d) => signal.match.test(d));
    if (hits.length) signals.push({ label: signal.label, role: signal.role, matched: hits.sort() });
  }

  return {
    manifests: found,
    ecosystems: [...ecosystems].sort(),
    dependencyCount: dependencies.size,
    signals: signals.sort((a, b) => a.role.localeCompare(b.role) || a.label.localeCompare(b.label)),
  };
}

/**
 * Run the detector table over the source files.
 *
 * @returns {{hits: object[], byDetector: object, truncated: object[], scannedFiles: number}}
 */
function detectSurfaces(root, files, options) {
  const opts = options || {};
  const maxHits = opts.maxHitsPerDetector || DEFAULT_MAX_HITS_PER_DETECTOR;

  const hits = [];
  const counts = new Map();
  const truncated = new Map();
  let scannedFiles = 0;

  for (const rel of files) {
    const applicable = detectorsFor(extensionOf(rel));
    if (!applicable.length) continue;

    let text;
    try {
      text = fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      continue;
    }
    scannedFiles += 1;

    const isTest = TEST_PATH.test(rel);
    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line.trim()) continue;

      for (const detector of applicable) {
        // A single reset per detector per line: the patterns are non-global, so lastIndex is not
        // carried between calls.
        if (!detector.pattern.test(line)) continue;

        const total = (counts.get(detector.id) || 0) + 1;
        counts.set(detector.id, total);

        if (total > maxHits) {
          truncated.set(detector.id, (truncated.get(detector.id) || 0) + 1);
          continue;
        }

        hits.push({
          detector: detector.id,
          label: detector.label,
          kind: detector.kind,
          file: rel,
          line: i + 1,
          ref: `${rel}:${i + 1}`,
          inTestCode: isTest,
          snippet: line.trim().slice(0, SNIPPET_LIMIT),
        });
      }
    }
  }

  const byDetector = {};
  for (const detector of DETECTORS) {
    const total = counts.get(detector.id) || 0;
    if (total) {
      byDetector[detector.id] = {
        label: detector.label,
        kind: detector.kind,
        total,
        reported: Math.min(total, maxHits),
      };
    }
  }

  return {
    hits,
    byDetector,
    scannedFiles,
    truncated: [...truncated.entries()].map(([id, dropped]) => ({
      detector: id,
      dropped,
      cap: maxHits,
      note: `Only the first ${maxHits} hits for this detector are listed. `
        + `${dropped} further hit(s) exist and were NOT reported — raise --max-hits to see them.`,
    })),
  };
}

/**
 * Scan a repository.
 *
 * @param {string} root
 * @param {object} [options]
 * @param {number} [options.maxFileBytes]
 * @param {number} [options.maxHitsPerDetector]
 * @returns {object} the full report
 */
function scan(root, options) {
  const opts = options || {};
  const absRoot = path.resolve(root);
  if (!fs.existsSync(absRoot)) throw new Error(`No such directory: ${absRoot}`);

  const ignoreDirs = readGitignoreDirs(absRoot);
  const { files, skipped, dirCount } = walk(absRoot, { ...opts, ignoreDirs });

  const testFiles = files.filter((f) => TEST_PATH.test(f));
  const schemaFiles = files.filter((f) => SCHEMA_PATH.test(f) && !TEST_PATH.test(f));

  const byExtension = {};
  for (const file of files) {
    const ext = extensionOf(file);
    byExtension[ext] = (byExtension[ext] || 0) + 1;
  }

  const stack = detectStack(absRoot, files);
  const surfaces = detectSurfaces(absRoot, files, opts);

  const productHits = surfaces.hits.filter((h) => !h.inTestCode);
  const byKind = productHits.reduce((acc, h) => {
    acc[h.kind] = (acc[h.kind] || 0) + 1;
    return acc;
  }, {});

  return {
    scanVersion: '1.0',
    root: absRoot,
    census: {
      directories: dirCount,
      files: files.length,
      sourceFilesScanned: surfaces.scannedFiles,
      testFiles: testFiles.length,
      schemaFiles: schemaFiles.length,
      byExtension: Object.fromEntries(
        Object.entries(byExtension).sort((a, b) => b[1] - a[1])
      ),
    },
    skipped: {
      ignoredDirectories: [...new Set(skipped.ignoredDirs)].sort(),
      binaryOrAssetFiles: skipped.binaryOrAsset,
      tooLarge: skipped.tooLarge,
      unreadable: skipped.unreadable,
      note: 'Anything listed here was NOT searched. If a surface lives in one of these, this scan '
        + 'did not see it.',
    },
    stack,
    modules: inferModules(files),
    candidateSurfaces: {
      byKind,
      byDetector: surfaces.byDetector,
      truncated: surfaces.truncated,
      hits: productHits,
    },
    existingTests: {
      files: testFiles,
      hitsInTestCode: surfaces.hits.length - productHits.length,
      note: 'Existing tests are listed so the designed suite complements them instead of '
        + 'duplicating them. They are never counted as product surfaces.',
    },
    schemaSources: schemaFiles,
    disclaimer:
      'Every entry under candidateSurfaces is a CANDIDATE produced by pattern matching. It names a '
      + 'place to read, not a behaviour that exists. Confirm each one in the source before it '
      + 'becomes a surface, a rule, or a test case.',
  };
}

module.exports = {
  scan,
  walk,
  detectStack,
  detectSurfaces,
  inferModules,
  extensionOf,
  readGitignoreDirs,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_HITS_PER_DETECTOR,
};
