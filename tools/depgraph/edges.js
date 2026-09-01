// Edge extraction: read one file and report what it imports and what it calls.
//
// Two kinds of edge come out of a file, and they answer different questions.
//
//   IMPORTS tell you WHAT the file depends on. They drive the closure walk: each internal import
//   is another file whose behaviour belongs to the part under test.
//
//   CALL SITES tell you WHERE the dependency is actually exercised, with a line number. That line
//   is what a test drives through and what an injected failure has to be attached to. An import
//   with no call site is a dependency the code does not use on any path - worth knowing, and NOT
//   worth a test.
//
// Matching a call site to the import that supplies it is done by SYMBOL, not by type inference: the
// imported binding names are collected, and a call whose head is one of those names is attributed to
// that import. This is right for the common cases and wrong for re-exported or aliased indirection,
// so an unattributed call is reported as such rather than assigned to a guess.

'use strict';

const fs = require('fs');
const path = require('path');

const { IMPORT_PATTERNS, CALL_PATTERNS, CALL_NOISE, languageOf } = require('./languages');

const MAX_FILE_BYTES = 1500000;

// Character constants. Named rather than inlined so the quote-scanning loop below stays legible
// and so no escape sequence in this file is ambiguous about which character it means.
const NEWLINE = String.fromCharCode(10);
const SPACE = String.fromCharCode(32);
const DQUOTE = String.fromCharCode(34);
const SQUOTE = String.fromCharCode(39);
const BACKTICK = String.fromCharCode(96);
const BACKSLASH = String.fromCharCode(92);

// ---------------------------------------------------------------------------
// Comment and string stripping
// ---------------------------------------------------------------------------

/**
 * Blank out line and block comments so a commented-out call is not reported as a live edge.
 *
 * This is the single highest-value correction in the whole extractor. A commented-out service
 * call that becomes a boundary surface produces a test for a code path that does not exist, which
 * fails forever and teaches the team to ignore the suite.
 *
 * Characters are replaced by spaces rather than removed, so every line number and column stays
 * exactly where it was - the evidence citation must point at the real line.
 */
function stripComments(text, lang) {
  const hashLangs = new Set(['py', 'rb']);
  const out = text.split('');
  const n = out.length;
  let i = 0;
  let state = 'code';
  let quote = '';

  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k += 1) {
      if (out[k] !== NEWLINE) out[k] = SPACE;
    }
  };

  while (i < n) {
    const c = out[i];
    const d = out[i + 1];

    if (state === 'code') {
      if (c === DQUOTE || c === SQUOTE || c === BACKTICK) {
        state = 'string';
        quote = c;
        i += 1;
        continue;
      }
      const lineComment = hashLangs.has(lang.id) ? c === '#' : c === '/' && d === '/';
      if (lineComment) {
        const e = text.indexOf(NEWLINE, i);
        blank(i, e === -1 ? n : e);
        i = e === -1 ? n : e;
        continue;
      }
      if (c === '/' && d === '*') {
        const e = text.indexOf('*/', i + 2);
        const end = e === -1 ? n : e + 2;
        blank(i, end);
        i = end;
        continue;
      }
      i += 1;
      continue;
    }

    // Inside a string: only the terminating quote matters, and an escape consumes the next char.
    if (c === BACKSLASH) { i += 2; continue; }
    if (c === quote) { state = 'code'; quote = ''; }
    i += 1;
  }

  return out.join('');
}
// ---------------------------------------------------------------------------
// Imported binding names - the link between an import and the calls it supplies
// ---------------------------------------------------------------------------

/**
 * Collect the local names an import statement introduces.
 *
 * `import { PromoService } from ...` introduces `PromoService`. A later
 * `new PromoService(` or `promoService.validate(` can then be attributed to that import,
 * which is what lets a call site be labelled internal or external without type inference.
 */
function bindingNamesFrom(line) {
  const names = new Set();

  // import { a, b as c } from ...   /   const { a, b } = require(...)
  const braced = line.match(/[{]([^}]*)[}]/);
  if (braced) {
    for (const part of braced[1].split(',')) {
      const seg = part.trim();
      if (!seg) continue;
      const asMatch = seg.match(/(?:as|=>)\s+([A-Za-z_$][\w$]*)$/);
      const name = asMatch ? asMatch[1] : seg.split(/\s+/)[0].replace(/[^A-Za-z_$\w]/g, '');
      if (name) names.add(name);
    }
  }

  // import Default from ...   /   const X = require(...)   /   import * as ns from ...
  const dflt = line.match(/^\s*import\s+([A-Za-z_$][\w$]*)/);
  if (dflt) names.add(dflt[1]);
  const star = line.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
  if (star) names.add(star[1]);
  const assigned = line.match(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/);
  if (assigned) names.add(assigned[1]);

  // Python: from x import A, B   /   import x.y as z
  const pyFrom = line.match(/^\s*from\s+[\w.]+\s+import\s+(.+)$/);
  if (pyFrom) {
    for (const part of pyFrom[1].split(',')) {
      const seg = part.trim().replace(/[()]/g, '');
      if (!seg) continue;
      const asMatch = seg.match(/\s+as\s+([A-Za-z_][\w]*)$/);
      names.add(asMatch ? asMatch[1] : seg.split(/\s+/)[0]);
    }
  }

  // Java / C# / PHP / Rust: the last segment of the qualified name is the local type name.
  const qualified = line.match(/(?:import|using|use)\s+(?:static\s+)?([\w.:\\]+)/);
  if (qualified) {
    const segs = qualified[1].split(/[.:\\]+/).filter(Boolean);
    const last = segs[segs.length - 1];
    if (last && last !== '*') names.add(last);
  }

  names.delete('');
  return names;
}
// ---------------------------------------------------------------------------
// The extractor
// ---------------------------------------------------------------------------

/**
 * Does this line DECLARE the named callable rather than invoke it?
 *
 * 'async validate(code: string)' and 'findByCode(code): Promise<T>' both look exactly like a call
 * to a line-based matcher. Counting a declaration as a call is not a cosmetic error: the symbol
 * becomes an edge to something the module already contains, and a module method can then be
 * reported as an external boundary - which would put a stub in front of code the suite is
 * supposed to be testing directly.
 *
 * The test is the syntax that can only precede a definition (a visibility or declaration keyword,
 * a return type, an interface member) - never a leading identifier, which is what a real call has.
 */
function declaresCallable(line, method) {
  const name = method.replace(/[?!]$/, '');
  const escaped = name.replace(/[^A-Za-z0-9_]/g, (ch) => '\\' + ch);
  const patterns = [
    // function / def / fn / sub declarations
    new RegExp('^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function|def|fn|sub)\\s+' + escaped + '\\b'),
    // class / interface members: visibility, static, async, override, decorators stripped
    new RegExp(
      '^\\s*(?:@[\\w.]+\\s*)*(?:(?:public|private|protected|internal|static|final|abstract|override|readonly|async|virtual|open|suspend|const|func|def)\\s+)*'
      + escaped
      + '\\s*[(<]'
    ),
    // Rust / Go style: fn name( , func (r T) Name(
    new RegExp('^\\s*(?:pub\\s+)?(?:async\\s+)?fn\\s+' + escaped + '\\b'),
    new RegExp('^\\s*func\\s+(?:\\([^)]*\\)\\s*)?' + escaped + '\\s*\\('),
  ];
  return patterns.some((re) => re.test(line));
}

/**
 * Map an injected field name to the TYPE that was injected into it.
 *
 * Constructor and field injection is how most server frameworks wire dependencies, and it breaks
 * naive symbol attribution completely: the file imports `PromoService`, but every call reads
 * `this.promos.validate(...)`. Without this map the import looks unused and the call site looks
 * like it belongs to nothing - so the dependency is recorded with no evidence of where it is
 * exercised, which is exactly the line a test has to drive and a failure has to be injected at.
 *
 * Recognises:
 *   constructor(private promos: PromoService)      TypeScript parameter properties
 *   private readonly PromoService promos;          Java / C# field declarations
 *   this.promos = promos;                          assignment in a constructor body
 *   promos: PromoService                           a bare typed field
 *
 * @returns {Map<string,string>} field name -> declared type name
 */
function injectedFieldTypes(text) {
  const out = new Map();
  const add = (field, type) => {
    if (!field || !type) return;
    if (field === type) return;
    if (!/^[A-Z]/.test(type)) return; // a type name, not a primitive or a generic parameter
    out.set(field, type);
  };

  // name: Type  (TypeScript, Kotlin, Swift). Covers constructor parameter properties and fields.
  const typedField = /(?:^|[(,\s;])(?:(?:public|private|protected|readonly|final|val|var|let)\s+)*([A-Za-z_][\w]*)\s*:\s*([A-Z][\w]*)/g;
  let m;
  while ((m = typedField.exec(text)) !== null) add(m[1], m[2]);

  // Type name  (Java, C#, Go struct fields) - the type precedes the field name.
  const typeFirst = /(?:^|[(,;{]|\s)(?:(?:public|private|protected|internal|readonly|final|static)\s+)*([A-Z][\w]*(?:<[^>]*>)?)\s+([a-z_][\w]*)\s*[;,)=]/g;
  while ((m = typeFirst.exec(text)) !== null) add(m[2], m[1].replace(/<.*$/, ''));

  // this.field = param  - the constructor body form. The param name usually matches the type
  // in lowerCamelCase, which is the only signal available here.
  const assigned = /this\.([A-Za-z_][\w]*)\s*=\s*([A-Za-z_][\w]*)/g;
  while ((m = assigned.exec(text)) !== null) {
    const cap = m[2].charAt(0).toUpperCase() + m[2].slice(1);
    if (!out.has(m[1])) add(m[1], cap);
  }

  return out;
}

/**
 * Extract every import and every call site from one file.
 *
 * @param {string} root  repository root (absolute)
 * @param {string} rel   repo-relative path of the file to read
 * @returns {{
 *   file: string, language: string|null, lines: number,
 *   imports: Array<{specifier: string|null, kind: string, line: number, ref: string,
 *                   bindings: string[], snippet: string}>,
 *   calls: Array<{receiver: string|null, method: string, head: string, line: number,
 *                 ref: string, snippet: string}>,
 *   skipped: string|null
 * }}
 */
function extractEdges(root, rel) {
  const empty = { file: rel, language: null, lines: 0, imports: [], calls: [], skipped: null };
  const lang = languageOf(rel);
  if (!lang) return { ...empty, skipped: 'unsupported language' };

  const abs = path.join(root, rel);
  let stat;
  try { stat = fs.statSync(abs); } catch (err) {
    return { ...empty, language: lang.id, skipped: 'unreadable: ' + (err.code || err.message) };
  }
  if (stat.size > MAX_FILE_BYTES) {
    return { ...empty, language: lang.id, skipped: 'too large: ' + stat.size + ' bytes' };
  }

  let raw;
  try { raw = fs.readFileSync(abs, 'utf8'); } catch (err) {
    return { ...empty, language: lang.id, skipped: 'unreadable: ' + (err.code || err.message) };
  }

  // Comments are blanked before matching. String literals are LEFT IN PLACE, because an import
  // specifier is itself a string literal - stripping them would remove every edge.
  const text = stripComments(raw, lang);
  const lines = text.split(NEWLINE);
  const rawLines = raw.split(NEWLINE);

  const importPatterns = IMPORT_PATTERNS.filter((x) => x.lang === lang.id);
  const callPatterns = CALL_PATTERNS.filter((x) => x.lang === lang.id);

  // Injected field -> type, so a `this.promos.validate(..)` call can be attributed to the
  // `PromoService` import even though the field name appears nowhere in the import statement.
  const fieldTypes = injectedFieldTypes(text);

  const imports = [];
  const calls = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    const lineNo = i + 1;
    const snippet = (rawLines[i] || '').trim().slice(0, 180);

    for (const pat of importPatterns) {
      const m = line.match(pat.pattern);
      if (!m) continue;
      const specifier = pat.opaque ? null : (m[1] || null);
      // A specifier that is only whitespace is not a specifier.
      if (!pat.opaque && (!specifier || !specifier.trim())) continue;
      imports.push({
        specifier,
        kind: pat.kind,
        line: lineNo,
        ref: rel + ':' + lineNo,
        bindings: [...bindingNamesFrom(line)],
        snippet,
      });
      break; // one import edge per line - the first matching pattern is the most specific
    }

    for (const pat of callPatterns) {
      const re = new RegExp(pat.pattern.source, 'g');
      let m;
      while ((m = re.exec(line)) !== null) {
        if (m.index === re.lastIndex) re.lastIndex += 1;
        const method = m[pat.methodGroup];
        if (!method || CALL_NOISE.has(method)) continue;
        // A declaration is not a call. Without this a module method becomes an edge to itself,
        // and can then be reported as an external boundary - stubbing the very code under test.
        if (declaresCallable(line, method)) continue;
        const receiver = pat.receiverGroup ? (m[pat.receiverGroup] || null) : null;
        // The head is the symbol a call is attributed by: the root of the receiver chain, or the
        // bare function name. `this.promoService.validate` heads at `promoService`,
        // because `this` names the enclosing class and carries no dependency information.
        const chain = receiver ? receiver.split(/[.:]|->/).filter(Boolean) : [];
        const meaningful = chain.filter((s) => s !== 'this' && s !== 'self');
        const head = meaningful.length ? meaningful[0] : method;
        if (CALL_NOISE.has(head)) continue;
        calls.push({ receiver, method, head, line: lineNo, ref: rel + ':' + lineNo, snippet });
      }
    }
  }

  return {
    file: rel,
    language: lang.id,
    lines: lines.length,
    imports,
    fieldTypes: Object.fromEntries(fieldTypes),
    calls: dedupeCalls(calls),
    skipped: null,
  };
}

/**
 * Collapse duplicate call records for the same symbol on the same line.
 *
 * Several patterns legitimately match one call - a method call also matches the bare-call pattern
 * - and reporting it twice would double every count downstream. The most specific record (the one
 * with a receiver) wins.
 */
function dedupeCalls(calls) {
  const byKey = new Map();
  for (const c of calls) {
    const key = c.line + '|' + c.head + '|' + c.method;
    const prev = byKey.get(key);
    if (!prev || (!prev.receiver && c.receiver)) byKey.set(key, c);
  }
  return [...byKey.values()].sort((a, b) => a.line - b.line || a.method.localeCompare(b.method));
}

module.exports = {
  extractEdges,
  stripComments,
  bindingNamesFrom,
  injectedFieldTypes,
  declaresCallable,
  dedupeCalls,
  MAX_FILE_BYTES,
};
