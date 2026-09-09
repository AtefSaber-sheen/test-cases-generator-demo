// Per-language tables for the dependency-graph engine.
//
// WHAT THIS SOLVES. Run the pipeline on a sub-part of a system, `src/checkout`, and the code in
// scope calls outward: into other modules of the same repository, and into libraries that are not in
// the repository at all. Those two cases must be treated in OPPOSITE ways, and telling them apart is
// the whole job of this file.
//
//   - An import that resolves to a file INSIDE the repo is readable. It is not a black box; it is
//     more scope. Its rules, branches and error paths belong to the execution coverage of the part
//     under test, so the closure follows it.
//   - An import that resolves NOWHERE in the repo is an external boundary. It cannot be read, so its
//     behaviour cannot be evidenced. But its CALL SITES can, and the handling of success and of
//     failure at each one is testable. It becomes a boundary surface, not a shrug.
//
// WHY REGEX AND NOT A PARSER. Same trade as `recon_scan/detectors.js`: what matters is coverage of
// the SEARCH across every ecosystem the package claims, and a per-language AST parser for each would
// break the zero-dependency promise. The cost is precision on dynamically resolved edges: a DI
// token, a runtime import of a computed path, a reflective Class.forName. Those are NOT silently
// dropped. They are classified `unresolved` and surface as gaps, so an incomplete graph reports
// itself instead of reading as complete.
//
// Adding a language means adding a row here. No other file in test-cases-generator-demo-tools/depgraph changes.

'use strict';

const path = require('path');
// ---------------------------------------------------------------------------
// Extension -> language, and the resolution rules that language needs
// ---------------------------------------------------------------------------

/**
 * Languages the graph engine can follow edges in.
 *
 * `moduleExtensions`  - extensions tried, in order, when a specifier has none. Order matters:
 *                       `.ts` before `.js` so a TypeScript repo that also ships compiled
 *                       output resolves to the source a test designer must read, not the build
 *                       artifact.
 * `indexFiles`        - filenames tried when a specifier resolves to a directory.
 * `relativePrefixes`  - what marks a specifier as repo-local rather than a package name.
 * `packageStyle`      - how a non-relative specifier becomes candidate repo paths, for languages
 *                       where every import looks absolute (Java, Go, C#, Python).
 */
const LANGUAGES = [
  {
    id: 'js',
    label: 'JavaScript / TypeScript',
    extensions: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.vue', '.svelte', '.astro'],
    moduleExtensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.astro'],
    indexFiles: ['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.mjs', 'index.cjs'],
    relativePrefixes: ['./', '../', '/'],
    packageStyle: 'node',
  },
  {
    id: 'py',
    label: 'Python',
    extensions: ['.py', '.pyi'],
    moduleExtensions: ['.py', '.pyi'],
    indexFiles: ['__init__.py'],
    relativePrefixes: ['.'],
    packageStyle: 'dotted',
  },
  {
    id: 'java',
    label: 'Java / Kotlin / Scala',
    extensions: ['.java', '.kt', '.kts', '.scala'],
    moduleExtensions: ['.java', '.kt', '.scala'],
    indexFiles: [],
    relativePrefixes: [],
    packageStyle: 'dotted',
  },
  {
    id: 'cs',
    label: 'C#',
    extensions: ['.cs'],
    moduleExtensions: ['.cs'],
    indexFiles: [],
    relativePrefixes: [],
    // A C# `using` names a namespace, not a file. Namespaces map to directories only by
    // convention, so resolution leans on the type name at the call site.
    packageStyle: 'namespace',
  },
  {
    id: 'go',
    label: 'Go',
    extensions: ['.go'],
    moduleExtensions: ['.go'],
    indexFiles: [],
    relativePrefixes: ['./', '../'],
    packageStyle: 'go-module',
  },
  {
    id: 'rb',
    label: 'Ruby',
    extensions: ['.rb', '.rake'],
    moduleExtensions: ['.rb'],
    indexFiles: [],
    relativePrefixes: ['./', '../'],
    packageStyle: 'path',
  },
  {
    id: 'php',
    label: 'PHP',
    extensions: ['.php', '.blade.php'],
    moduleExtensions: ['.php'],
    indexFiles: [],
    relativePrefixes: ['./', '../'],
    packageStyle: 'namespace',
  },
  {
    id: 'rs',
    label: 'Rust',
    extensions: ['.rs'],
    moduleExtensions: ['.rs'],
    indexFiles: ['mod.rs', 'lib.rs', 'main.rs'],
    relativePrefixes: [],
    packageStyle: 'crate',
  },
];

const EXT_TO_LANGUAGE = new Map();
for (const lang of LANGUAGES) {
  for (const ext of lang.extensions) EXT_TO_LANGUAGE.set(ext, lang);
}

/** `.blade.php` must beat `.php`, so the compound extension is checked first. */
function languageOf(file) {
  const lower = String(file).toLowerCase();
  if (lower.endsWith('.blade.php')) return EXT_TO_LANGUAGE.get('.blade.php') || null;
  return EXT_TO_LANGUAGE.get(path.extname(lower)) || null;
}
// ---------------------------------------------------------------------------
// Import edges - which module a file declares a dependency on
// ---------------------------------------------------------------------------

/**
 * Each pattern captures the SPECIFIER in group 1, except where `opaque` is set. An opaque match
 * means an edge exists here but source cannot say to what, which becomes an `unresolved` record
 * rather than being dropped.
 *
 * Patterns run per line. A multi-line import is matched on the line carrying the specifier, which
 * is where the specifier always is for every syntax below.
 */
const IMPORT_PATTERNS = [
  // --- JavaScript / TypeScript ---
  { lang: 'js', kind: 'static', pattern: /^\s*import\s+[^'"]*from\s*['"]([^'"]+)['"]/ },
  { lang: 'js', kind: 'static', pattern: /^\s*import\s*['"]([^'"]+)['"]/ },
  { lang: 'js', kind: 'static', pattern: /^\s*export\s+[^'"]*from\s*['"]([^'"]+)['"]/ },
  { lang: 'js', kind: 'static', pattern: /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/ },
  { lang: 'js', kind: 'dynamic', pattern: /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/ },
  { lang: 'js', kind: 'unresolvable', pattern: /\bimport\s*\(\s*(?!['"])[^)\s][^)]*\)/, opaque: true },
  { lang: 'js', kind: 'unresolvable', pattern: /\brequire\s*\(\s*(?!['"])[^)\s][^)]*\)/, opaque: true },

  // --- Python ---
  { lang: 'py', kind: 'static', pattern: /^\s*from\s+([.\w]+)\s+import\s+/ },
  { lang: 'py', kind: 'static', pattern: /^\s*import\s+([.\w]+)/ },
  { lang: 'py', kind: 'unresolvable', pattern: /\b(?:importlib\.import_module|__import__)\s*\(/, opaque: true },

  // --- Java / Kotlin / Scala ---
  { lang: 'java', kind: 'static', pattern: /^\s*import\s+(?:static\s+)?([\w.]+?)(?:\.\*)?\s*;?\s*$/ },
  { lang: 'java', kind: 'unresolvable', pattern: /\bClass\.forName\s*\(/, opaque: true },

  // --- C# ---
  { lang: 'cs', kind: 'static', pattern: /^\s*(?:global\s+)?using\s+(?:static\s+)?([\w.]+)\s*;/ },
  { lang: 'cs', kind: 'unresolvable', pattern: /\bType\.GetType\s*\(|\bActivator\.CreateInstance\s*\(/, opaque: true },

  // --- Go ---
  { lang: 'go', kind: 'static', pattern: /^\s*import\s+(?:[\w.]+\s+)?"([\w./-]+)"/ },
  { lang: 'go', kind: 'static', pattern: /^\s*(?:[\w.]+\s+)?"([\w./-]+)"\s*$/ },

  // --- Ruby ---
  { lang: 'rb', kind: 'static', pattern: /^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/ },
  { lang: 'rb', kind: 'unresolvable', pattern: /^\s*require\s+[^'"\s]+\s*$/, opaque: true },

  // --- PHP ---
  { lang: 'php', kind: 'static', pattern: /^\s*use\s+([\w\\]+)(?:\s+as\s+\w+)?\s*;/ },
  { lang: 'php', kind: 'static', pattern: /\b(?:require|require_once|include|include_once)\s*\(?\s*['"]([^'"]+)['"]/ },

  // --- Rust ---
  { lang: 'rs', kind: 'static', pattern: /^\s*(?:pub\s+)?use\s+([\w:]+)/ },
  { lang: 'rs', kind: 'static', pattern: /^\s*(?:pub\s+)?mod\s+(\w+)\s*;/, modDeclaration: true },
];
// ---------------------------------------------------------------------------
// Call sites - where control actually leaves the code under test
// ---------------------------------------------------------------------------

/**
 * A call site is what makes an edge TESTABLE rather than merely present.
 *
 * An import says a dependency exists. A call site says WHERE control leaves the code under test:
 * the point a test must drive through, and the point at which an external failure has to be
 * injected. Stage 3 needs the line, not the module.
 *
 * Each pattern puts the receiver in `receiverGroup` and the invoked name in `methodGroup`. A
 * null receiverGroup means a bare call with no receiver. The caller adds the `g` flag so every
 * call on a chained line is found, not only the first.
 */
const CALL_PATTERNS = [
  {
    lang: 'js',
    label: 'method call on a receiver',
    // `this.promoService.validate(` / `stripe.charges.create(` / `await repo.findMany(`
    pattern: /(?:^|[^\w.$])(?:await\s+)?((?:this\.)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*?)\.([A-Za-z_$][\w$]*)\s*\(/,
    receiverGroup: 1,
    methodGroup: 2,
  },
  {
    lang: 'js',
    label: 'bare function call',
    pattern: /(?:^|[^\w.$])(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(/,
    receiverGroup: null,
    methodGroup: 1,
  },
  {
    lang: 'js',
    label: 'constructor',
    pattern: /\bnew\s+([A-Z][\w$]*)\s*\(/,
    receiverGroup: null,
    methodGroup: 1,
  },
  {
    lang: 'py',
    label: 'method call on a receiver',
    pattern: /(?:^|[^\w.])(?:await\s+)?((?:self\.)?[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*?)\.([A-Za-z_]\w*)\s*\(/,
    receiverGroup: 1,
    methodGroup: 2,
  },
  {
    lang: 'py',
    label: 'bare function call',
    pattern: /(?:^|[^\w.])(?:await\s+)?([A-Za-z_]\w*)\s*\(/,
    receiverGroup: null,
    methodGroup: 1,
  },
  {
    lang: 'java',
    label: 'method call on a receiver',
    pattern: /(?:^|[^\w.])((?:this\.)?[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*?)\.([a-z]\w*)\s*\(/,
    receiverGroup: 1,
    methodGroup: 2,
  },
  {
    lang: 'java',
    label: 'constructor',
    pattern: /\bnew\s+([A-Z]\w*)\s*[(<]/,
    receiverGroup: null,
    methodGroup: 1,
  },
  {
    lang: 'cs',
    label: 'method call on a receiver',
    pattern: /(?:^|[^\w.])(?:await\s+)?((?:this\.)?[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*?)\.([A-Z]\w*)\s*\(/,
    receiverGroup: 1,
    methodGroup: 2,
  },
  {
    lang: 'cs',
    label: 'constructor',
    pattern: /\bnew\s+([A-Z]\w*)\s*[(<]/,
    receiverGroup: null,
    methodGroup: 1,
  },
  {
    lang: 'go',
    label: 'method or package call',
    pattern: /(?:^|[^\w.])([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*?)\.([A-Z]\w*)\s*\(/,
    receiverGroup: 1,
    methodGroup: 2,
  },
  {
    lang: 'rb',
    label: 'method call on a receiver',
    pattern: /(?:^|[^\w.])([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*?)\.([a-z_]\w*[?!]?)\s*[(\s]/,
    receiverGroup: 1,
    methodGroup: 2,
  },
  {
    lang: 'php',
    label: 'instance call through a variable chain',
    // `$this->promoService->validate(` - the receiver is the whole chain
    pattern: /(\$\w+(?:\s*->\s*\w+)*?)\s*->\s*([A-Za-z_]\w*)\s*\(/,
    receiverGroup: 1,
    methodGroup: 2,
  },
  {
    lang: 'php',
    label: 'static or self call',
    pattern: /\b([A-Z]\w*|self|static|parent)\s*::\s*([A-Za-z_]\w*)\s*\(/,
    receiverGroup: 1,
    methodGroup: 2,
  },
  {
    lang: 'rs',
    label: 'method or path call',
    pattern: /(?:^|[^\w:.])([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*?)(?:\.|::)([a-z_]\w*)\s*\(/,
    receiverGroup: 1,
    methodGroup: 2,
  },
];
/**
 * Call names that are language or standard-library noise.
 *
 * Without this the call-site list is dominated by `map`, `push` and `toString`, burying the
 * edges that matter. Excluding them loses nothing: a test never needs to know that a function
 * called `map`. The list is deliberately conservative, because a missed edge costs more than a
 * noisy one - anything domain-shaped is kept.
 */
const CALL_NOISE = new Set([
  // control flow and keywords that can lex as a call
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'instanceof', 'await', 'function',
  'super', 'this', 'constructor', 'require', 'import', 'export', 'class', 'def', 'lambda', 'print',
  'case', 'do', 'else', 'elif', 'try', 'finally', 'with', 'yield', 'raise', 'throw', 'new', 'and',
  'or', 'not', 'in', 'is', 'as', 'pass', 'assert', 'del', 'global', 'nonlocal', 'fn', 'let',
  'const', 'var', 'struct', 'enum', 'impl', 'trait', 'pub', 'mod', 'use', 'defer', 'go', 'select',
  // collection and functional plumbing
  'map', 'filter', 'reduce', 'forEach', 'find', 'findIndex', 'some', 'every', 'flat', 'flatMap',
  'push', 'pop', 'shift', 'unshift', 'slice', 'splice', 'concat', 'join', 'sort', 'reverse',
  'includes', 'indexOf', 'keys', 'values', 'entries', 'length', 'size', 'append', 'extend',
  'items', 'has', 'clear', 'copy', 'clone', 'range', 'len', 'enumerate', 'zip',
  // string, number and conversion
  'toString', 'valueOf', 'toFixed', 'trim', 'split', 'replace', 'replaceAll', 'match', 'matchAll',
  'test', 'exec', 'startsWith', 'endsWith', 'padStart', 'padEnd', 'toLowerCase', 'toUpperCase',
  'parseInt', 'parseFloat', 'Number', 'String', 'Boolean', 'Array', 'Object', 'JSON', 'format',
  'str', 'int', 'float', 'bool', 'list', 'dict', 'tuple', 'strip', 'lower', 'upper',
  // promise plumbing
  'then', 'resolve', 'reject', 'all', 'allSettled', 'race', 'any',
  // logging and assertions
  'log', 'warn', 'error', 'info', 'debug', 'trace', 'console', 'expect',
]);

/**
 * Non-relative specifier prefixes that name a repo-internal path by CONFIGURATION rather than by
 * filesystem position: a tsconfig path alias, a jsconfig alias, a bundler alias.
 *
 * These are the commonest cause of a real internal edge being misfiled as external, which would
 * turn readable code into a fake black box. Aliases DECLARED in a manifest are read by
 * `resolve.js`; this table is the fallback for the conventional ones no config declares.
 */
const CONVENTIONAL_ALIASES = [
  { prefix: '@/', roots: ['src', 'app', '.'] },
  { prefix: '~/', roots: ['src', 'app', '.'] },
  { prefix: '@app/', roots: ['src', 'app'] },
  { prefix: '@src/', roots: ['src'] },
  { prefix: 'src/', roots: ['.'] },
  { prefix: 'app/', roots: ['.'] },
];
/**
 * Externals whose FAILURE MODES are known well enough to name, so Stage 3 can generate the
 * failure branch concretely instead of writing "simulate an error".
 *
 * The role decides what a boundary test looks like: an HTTP dependency times out and returns 5xx,
 * a database deadlocks and violates constraints, a payment gateway declines a card. Getting the
 * role right is what turns a boundary from a stub into covered execution paths.
 */
const EXTERNAL_ROLES = [
  { match: /^(axios|node-fetch|got|superagent|undici|requests|httpx|urllib3|okhttp|resttemplate|reqwest)$/i, role: 'http-client', label: 'Outbound HTTP' },
  { match: /^(@aws-sdk|aws-sdk|boto3|google-cloud|@google-cloud|@azure)$/i, role: 'cloud-sdk', label: 'Cloud SDK' },
  { match: /^(stripe|braintree|paypal|adyen|square)$/i, role: 'payment', label: 'Payment gateway' },
  { match: /^(@prisma|prisma|typeorm|sequelize|mongoose|drizzle-orm|knex|sqlalchemy|pg|mysql2|mongodb)$/i, role: 'database', label: 'Database / ORM' },
  { match: /^(redis|ioredis|memcached|node-cache)$/i, role: 'cache', label: 'Cache' },
  { match: /^(kafkajs|amqplib|pika|bullmq|bull|celery)$/i, role: 'queue', label: 'Queue / broker' },
  { match: /^(nodemailer|@sendgrid|mailgun|postmark|ses)$/i, role: 'email', label: 'Email' },
  { match: /^(twilio|firebase-admin|onesignal)$/i, role: 'notification', label: 'Notification' },
  { match: /^(launchdarkly|unleash-client|@openfeature)$/i, role: 'feature-flags', label: 'Feature flags' },
  { match: /^(jsonwebtoken|jose|pyjwt|passport|next-auth|@auth|auth0)$/i, role: 'auth-provider', label: 'Auth provider' },
  { match: /^(fs|path|os|crypto|util|stream|pathlib|shutil)$/i, role: 'runtime', label: 'Language runtime' },
  { match: /^(dayjs|moment|date-fns|luxon|datetime|arrow)$/i, role: 'clock', label: 'Clock / date' },
];

/** Node built-ins never resolve into the repo. Listed so they are classified, not guessed at. */
const RUNTIME_BUILTINS = new Set([
  'fs', 'fs/promises', 'path', 'os', 'crypto', 'util', 'stream', 'events', 'http', 'https', 'url',
  'zlib', 'buffer', 'child_process', 'assert', 'net', 'tls', 'dns', 'querystring', 'readline',
  'worker_threads', 'perf_hooks', 'timers', 'timers/promises', 'string_decoder', 'v8', 'vm',
]);

/**
 * Classify an external specifier by the failure modes it can produce.
 *
 * The full bare name is tried first, then the package scope or head, so `@aws-sdk/client-sqs`
 * is a cloud SDK and `@sendgrid/mail` is email.
 */
function externalRoleOf(specifier) {
  const bare = String(specifier).replace(/^node:/, '');
  for (const entry of EXTERNAL_ROLES) {
    if (entry.match.test(bare)) return { role: entry.role, label: entry.label };
  }
  const head = bare.split('/')[0];
  if (head !== bare) {
    for (const entry of EXTERNAL_ROLES) {
      if (entry.match.test(head)) return { role: entry.role, label: entry.label };
    }
  }
  return { role: 'unclassified', label: 'Third-party package' };
}

module.exports = {
  LANGUAGES,
  IMPORT_PATTERNS,
  CALL_PATTERNS,
  CALL_NOISE,
  CONVENTIONAL_ALIASES,
  EXTERNAL_ROLES,
  RUNTIME_BUILTINS,
  languageOf,
  externalRoleOf,
};
