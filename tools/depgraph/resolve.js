// Specifier resolution: turn an import string into a repository file, or say why it could not be.
//
// THE DECISION THIS FILE MAKES. For every import found in the code under test, exactly one of:
//
//   internal   - it resolves to a file in this repository. The closure follows it, because that
//                file is readable and its behaviour is part of the execution coverage of the part
//                under test. Not a black box: more scope.
//   external   - it names a package that is not in this repository. It cannot be read, so it
//                becomes a BOUNDARY: its call sites are recorded and Stage 3 covers the success
//                and the failure branch of each caller.
//   unresolved - an edge exists and the target cannot be determined from source (a DI token, a
//                computed import, a reflective lookup). Reported as a gap, never guessed at.
//
// The third outcome is the one that makes this honest. A resolver that silently drops what it
// cannot follow produces a closure that reads complete and is not, and every coverage number
// computed from it is then wrong in the same invisible direction.
//
// ALIASES ARE READ, NOT ASSUMED. A tsconfig/jsconfig path mapping is the commonest reason a real
// internal edge looks like a package name. Those files are parsed when present; the conventional
// prefixes in languages.js are only the fallback.

'use strict';

const fs = require('fs');
const path = require('path');

const { LANGUAGES, CONVENTIONAL_ALIASES, RUNTIME_BUILTINS, languageOf } = require('./languages');

// ---------------------------------------------------------------------------
// Alias maps declared by the repository itself
// ---------------------------------------------------------------------------

/**
 * Read path aliases out of tsconfig/jsconfig.
 *
 * JSON with comments and trailing commas is common in these files, so the parse is tolerant: on
 * failure the aliases are simply absent, and resolution falls back to the conventional prefixes.
 * A hard failure here would abort a scan over a formatting quirk, which is the wrong trade.
 *
 * @returns {Array<{prefix: string, roots: string[], source: string}>}
 */
function readDeclaredAliases(root) {
  const out = [];
  const candidates = ['tsconfig.json', 'jsconfig.json', 'tsconfig.base.json'];
  for (const name of candidates) {
    const abs = path.join(root, name);
    if (!fs.existsSync(abs)) continue;
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }

    // Strip comments and trailing commas - tsconfig is JSON5-ish in practice.
    const cleaned = text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      .replace(/,(\s*[}\]])/g, '$1');

    let json;
    try { json = JSON.parse(cleaned); } catch { continue; }

    const opts = (json && json.compilerOptions) || {};
    const baseUrl = opts.baseUrl || '.';
    const paths = opts.paths || {};
    for (const [pattern, targets] of Object.entries(paths)) {
      if (!Array.isArray(targets)) continue;
      // @app/*: [src/app/*] -> prefix @app/, roots [src/app]
      const prefix = pattern.replace(/\*$/, '');
      const roots = targets.map((t) => path.posix.join(baseUrl, String(t).replace(/\/?\*$/, '')));
      out.push({ prefix, roots, source: name });
    }
  }
  // Longest prefix first, so @app/ui/ wins over @app/.
  return out.sort((a, b) => b.prefix.length - a.prefix.length);
}
// ---------------------------------------------------------------------------
// Candidate generation and lookup
// ---------------------------------------------------------------------------

/** Normalise to repo-relative POSIX form, which is how every path in the report is expressed. */
function rel(root, abs) {
  return path.relative(root, abs).split(path.sep).join('/');
}

/**
 * Candidate repo paths for a specifier that is already known to be a path.
 *
 * Tries, in order: the path as given, the path plus each module extension, and each index file
 * inside it as a directory. The FIRST hit in the file set wins, which is why extension order in
 * languages.js matters - a repo shipping both .ts and compiled .js must resolve to the .ts.
 */
function candidatesFor(base, lang) {
  const out = [base];
  for (const ext of lang.moduleExtensions) out.push(base + ext);
  for (const idx of lang.indexFiles) out.push(base + '/' + idx);
  return out;
}

/**
 * Resolve one import specifier.
 *
 * @param {object} args
 * @param {string} args.root        repository root (absolute)
 * @param {string} args.fromFile    repo-relative path of the importing file
 * @param {string} args.specifier   the raw specifier as written in source
 * @param {Set<string>} args.fileSet every repo-relative file path, for O(1) existence checks
 * @param {Array} [args.aliases]    declared aliases from readDeclaredAliases
 * @returns {{status: string, target?: string, reason?: string, via?: string}}
 *          status is 'internal', 'external' or 'unresolved'.
 */
function resolveSpecifier(args) {
  const { root, fromFile, specifier, fileSet } = args;
  const aliases = args.aliases || [];
  const lang = languageOf(fromFile);
  if (!lang) return { status: 'unresolved', reason: 'unknown language for the importing file' };
  if (!specifier) return { status: 'unresolved', reason: 'specifier not determinable from source' };

  const spec = String(specifier).trim();

  // A language runtime module is external by definition and never worth a filesystem probe.
  if (RUNTIME_BUILTINS.has(spec.replace(/^node:/, ''))) {
    return { status: 'external', reason: 'language runtime module' };
  }

  const hit = (cands, via) => {
    for (const c of cands) {
      const norm = c.split(path.sep).join('/').replace(/^\.\//, '');
      if (fileSet.has(norm)) return { status: 'internal', target: norm, via };
    }
    return null;
  };
  // 1. Relative to the importing file. The commonest internal edge, and unambiguous.
  const isRelative = lang.relativePrefixes.some((pre) => spec.startsWith(pre));
  if (isRelative && lang.id !== 'py') {
    const dir = path.posix.dirname(fromFile);
    const joined = path.posix.normalize(path.posix.join(dir, spec));
    const found = hit(candidatesFor(joined, lang), 'relative');
    if (found) return found;
    return {
      status: 'unresolved',
      reason: 'relative path does not resolve to a file in the repository',
    };
  }

  // 2. Python relative import: leading dots count levels up from the current package.
  if (lang.id === 'py' && spec.startsWith('.')) {
    const dots = (spec.match(/^\.+/) || [''])[0].length;
    const rest = spec.slice(dots).replace(/\./g, '/');
    let dir = path.posix.dirname(fromFile);
    for (let i = 1; i < dots; i += 1) dir = path.posix.dirname(dir);
    const joined = rest ? path.posix.join(dir, rest) : dir;
    const found = hit(candidatesFor(joined, lang), 'relative');
    if (found) return found;
    return { status: 'unresolved', reason: 'relative import does not resolve inside the repository' };
  }

  // 3. A declared alias (tsconfig/jsconfig paths). Read from the repo, so it is evidence.
  for (const alias of aliases) {
    if (!alias.prefix || !spec.startsWith(alias.prefix)) continue;
    const tail = spec.slice(alias.prefix.length);
    for (const r of alias.roots) {
      const found = hit(candidatesFor(path.posix.join(r, tail), lang), 'alias:' + alias.source);
      if (found) return found;
    }
  }

  // 4. A conventional alias no config declared. Weaker evidence, so it is reported via 'alias:convention'.
  for (const alias of CONVENTIONAL_ALIASES) {
    if (!spec.startsWith(alias.prefix)) continue;
    const tail = spec.slice(alias.prefix.length);
    for (const r of alias.roots) {
      const base = r === '.' ? tail : path.posix.join(r, tail);
      const found = hit(candidatesFor(base, lang), 'alias:convention');
      if (found) return found;
    }
  }
  // 5. Dotted / namespaced specifiers: Java, Kotlin, C#, Python absolute, Rust, PHP.
  //
  //    These name a package or namespace, not a path. The trick that works across all of them:
  //    convert the separator to / and try the resulting path from every plausible source root,
  //    then progressively drop leading segments (com.acme.app.promo -> acme/app/promo -> app/promo
  //    -> promo). A monorepo where the namespace root is not a directory still resolves.
  if (['dotted', 'namespace', 'crate'].includes(lang.packageStyle)) {
    const sep = lang.id === 'rs' ? /::/g : /[.\\]/g;
    const segments = spec.split(sep).filter(Boolean);
    const SOURCE_ROOTS = [
      '', 'src', 'app', 'lib', 'src/main/java', 'src/main/kotlin', 'src/main/scala',
      'src/test/java', 'source', 'Source',
    ];
    for (let drop = 0; drop < segments.length; drop += 1) {
      const tail = segments.slice(drop).join('/');
      if (!tail) continue;
      for (const r of SOURCE_ROOTS) {
        const base = r ? path.posix.join(r, tail) : tail;
        const found = hit(candidatesFor(base, lang), drop === 0 ? 'package-path' : 'package-path-suffix');
        if (found) return found;
      }
    }
    // Rust `mod x;` names a sibling file or directory, not a package.
    if (lang.id === 'rs') {
      const dir = path.posix.dirname(fromFile);
      const found = hit(candidatesFor(path.posix.join(dir, spec), lang), 'mod-sibling');
      if (found) return found;
    }
    return { status: 'external', reason: 'namespace not found under any source root in this repository' };
  }

  // 6. Go: an import path is prefixed by the module path from go.mod. Strip it and the remainder
  //    is a directory in this repo; a Go package is a directory, so any file in it is the target.
  if (lang.packageStyle === 'go-module') {
    const modulePath = args.goModulePath;
    let tail = spec;
    if (modulePath && spec.startsWith(modulePath)) {
      tail = spec.slice(modulePath.length).replace(/^\//, '');
    } else if (spec.includes('.') && spec.includes('/')) {
      // Looks like a fully qualified third-party path and does not match this module.
      return { status: 'external', reason: 'import path outside this Go module' };
    }
    if (tail) {
      const inDir = [...fileSet].find((f) => f.startsWith(tail + '/') && f.endsWith('.go'));
      if (inDir) return { status: 'internal', target: inDir, via: 'go-package-dir' };
    }
    return { status: 'external', reason: 'no directory in this repository matches the import path' };
  }

  // 7. Ruby / PHP path-style requires.
  if (lang.packageStyle === 'path') {
    for (const r of ['', 'lib', 'app', 'src']) {
      const base = r ? path.posix.join(r, spec) : spec;
      const found = hit(candidatesFor(base, lang), 'path-style');
      if (found) return found;
    }
    return { status: 'external', reason: 'gem or library not present as a file in this repository' };
  }

  // 8. Node bare specifier: a workspace package resolves internally, anything else is external.
  //    A workspace package is found by its own package.json name, which is the only reliable
  //    signal - a monorepo package directory rarely matches its published name.
  const workspace = args.workspacePackages || new Map();
  for (const [name, entry] of workspace) {
    if (spec !== name && !spec.startsWith(name + '/')) continue;
    const tail = spec === name ? '' : spec.slice(name.length + 1);
    const base = tail ? path.posix.join(path.posix.dirname(entry.manifest), tail) : entry.entryPoint;
    const found = hit(candidatesFor(base, lang), 'workspace-package');
    if (found) return found;
    if (entry.entryPoint && fileSet.has(entry.entryPoint)) {
      return { status: 'internal', target: entry.entryPoint, via: 'workspace-package' };
    }
  }

  return { status: 'external', reason: 'bare specifier with no matching workspace package' };
}
// ---------------------------------------------------------------------------
// Workspace and module metadata
// ---------------------------------------------------------------------------

/**
 * Map every workspace package name to its manifest and entry point.
 *
 * In a monorepo this is what separates an internal edge from an external one. `@acme/billing`
 * looks exactly like a third-party package until you know the repo declares it, and misfiling it
 * as external turns readable first-party code into a fake black box - the precise failure this
 * whole engine exists to prevent.
 */
function readWorkspacePackages(root, files) {
  const out = new Map();
  for (const rel of files) {
    if (path.posix.basename(rel) !== 'package.json') continue;
    let json;
    try { json = JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')); } catch { continue; }
    if (!json || !json.name) continue;

    const dir = path.posix.dirname(rel);
    const mainField = json.main || json.module || (json.exports && typeof json.exports === 'string' ? json.exports : null);
    const entry = mainField ? path.posix.normalize(path.posix.join(dir, String(mainField))) : null;
    out.set(json.name, {
      manifest: rel,
      dir,
      entryPoint: entry && files.includes(entry) ? entry : null,
    });
  }
  return out;
}

/** The module path declared in go.mod, which prefixes every internal Go import. */
function readGoModulePath(root) {
  const abs = path.join(root, 'go.mod');
  if (!fs.existsSync(abs)) return null;
  try {
    const m = fs.readFileSync(abs, 'utf8').match(/^\s*module\s+(\S+)/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Build the resolution context once per repository, so a closure walk does not re-read manifests
 * for every edge it follows.
 */
function buildResolveContext(root, files) {
  return {
    root,
    fileSet: new Set(files),
    aliases: readDeclaredAliases(root),
    workspacePackages: readWorkspacePackages(root, files),
    goModulePath: readGoModulePath(root),
  };
}

/** Resolve using a prebuilt context. This is the entry point the closure walker uses. */
function resolveWithContext(ctx, fromFile, specifier) {
  return resolveSpecifier({
    root: ctx.root,
    fromFile,
    specifier,
    fileSet: ctx.fileSet,
    aliases: ctx.aliases,
    workspacePackages: ctx.workspacePackages,
    goModulePath: ctx.goModulePath,
  });
}

module.exports = {
  readDeclaredAliases,
  readWorkspacePackages,
  readGoModulePath,
  buildResolveContext,
  resolveSpecifier,
  resolveWithContext,
  candidatesFor,
  rel,
};
