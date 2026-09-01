'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { languageOf, externalRoleOf, CALL_NOISE } = require('../languages');
const { buildResolveContext, resolveWithContext, readDeclaredAliases } = require('../resolve');
const { extractEdges, stripComments, injectedFieldTypes, declaresCallable } = require('../edges');
const { walkClosure, selectSeeds, normPath } = require('../closure');
const { classifyBoundaries, summariseBoundaries, slugFor } = require('../boundary');
const { renderClosureMarkdown } = require('../render');

/**
 * A miniature multi-layer service.
 *
 * The shape matters: the checkout controller is FOUR hops from the ORM, and two of its
 * dependencies are unreadable packages. A scope filter would inventory only the first file, which
 * is exactly the failure the closure exists to prevent - so the fixture is built to make that
 * failure visible if it ever comes back.
 */
const REPO = {
  'package.json': JSON.stringify({
    name: 'shop',
    dependencies: { stripe: '^14.0.0', axios: '^1.6.0', '@prisma/client': '^5.0.0' },
  }, null, 2),

  'tsconfig.json': JSON.stringify({
    compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['src/lib/*'] } },
  }, null, 2),

  // depth 0 - the seed
  'src/checkout/checkout.controller.ts': [
    "import { PromoService } from '../promotions/promo.service';",
    "import { PaymentService } from '../payments/payment.service';",
    "import { money } from '@lib/money';",
    'export class CheckoutController {',
    '  constructor(private promos: PromoService, private pay: PaymentService) {}',
    '  async submit(body: any) {',
    '    const promo = await this.promos.validate(body.code);',
    '    return this.pay.charge(money(body.amount));',
    '  }',
    '}',
  ].join('\n'),

  // depth 1
  'src/promotions/promo.service.ts': [
    "import { PromoRepo } from './promo.repo';",
    'export class PromoService {',
    '  constructor(private repo: PromoRepo) {}',
    '  async validate(code: string) {',
    '    return this.repo.findByCode(code);',
    '  }',
    '}',
  ].join('\n'),

  'src/payments/payment.service.ts': [
    "import Stripe from 'stripe';",
    'export class PaymentService {',
    '  private client = new Stripe(process.env.KEY);',
    '  async charge(amount: number) {',
    '    return this.client.charges.create({ amount });',
    '  }',
    '}',
  ].join('\n'),

  // depth 2
  'src/promotions/promo.repo.ts': [
    "import { PrismaClient } from '@prisma/client';",
    'export class PromoRepo {',
    '  private db = new PrismaClient();',
    '  async findByCode(code: string) {',
    '    return this.db.promotion.findUnique({ where: { code } });',
    '  }',
    '}',
  ].join('\n'),

  // reached through a tsconfig path alias, which is the case that most often gets misfiled
  'src/lib/money.ts': 'export function money(n: number) { return Math.round(n * 100) / 100; }',

  // outside the closure, but calls into it - blast radius
  'src/admin/admin.controller.ts': [
    "import { PromoService } from '../promotions/promo.service';",
    'export class AdminController {',
    '  constructor(private promos: PromoService) {}',
    '  async check(c: string) { return this.promos.validate(c); }',
    '}',
  ].join('\n'),

  // unrelated - must never appear in a src/checkout closure
  'src/unrelated/thing.ts': 'export const x = 1;',
};

function writeRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depgraph-test-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf8');
  }
  return dir;
}

const SOURCE_FILES = Object.keys(REPO).filter((f) => languageOf(f) !== null);

// ---------------------------------------------------------------------------
// languages
// ---------------------------------------------------------------------------

test('a compound extension resolves to the right language, not the shorter match', () => {
  assert.equal(languageOf('views/home.blade.php').id, 'php');
  assert.equal(languageOf('src/a.ts').id, 'js');
  assert.equal(languageOf('README.md'), null);
});

test('an external is classified by the failure modes its role can produce', () => {
  assert.equal(externalRoleOf('stripe').role, 'payment');
  assert.equal(externalRoleOf('@prisma/client').role, 'database');
  assert.equal(externalRoleOf('axios').role, 'http-client');
  // A scoped package falls back to its scope, so client-sqs is still a cloud SDK.
  assert.equal(externalRoleOf('@aws-sdk/client-sqs').role, 'cloud-sdk');
  // An unknown package is still classified, so it still gets generic coverage.
  assert.equal(externalRoleOf('some-unknown-lib').role, 'unclassified');
});

// ---------------------------------------------------------------------------
// resolve
// ---------------------------------------------------------------------------

test('a relative import resolves to the file it names', () => {
  const root = writeRepo(REPO);
  const ctx = buildResolveContext(root, SOURCE_FILES);
  const r = resolveWithContext(ctx, 'src/checkout/checkout.controller.ts', '../promotions/promo.service');
  assert.equal(r.status, 'internal');
  assert.equal(r.target, 'src/promotions/promo.service.ts');
});

test('a declared tsconfig alias resolves internally rather than looking like a package', () => {
  const root = writeRepo(REPO);
  const aliases = readDeclaredAliases(root);
  assert.ok(aliases.some((a) => a.prefix === '@lib/'), 'the tsconfig paths entry must be read');

  const ctx = buildResolveContext(root, SOURCE_FILES);
  const r = resolveWithContext(ctx, 'src/checkout/checkout.controller.ts', '@lib/money');
  // This is the case that turns first-party code into a fake black box when it goes wrong.
  assert.equal(r.status, 'internal');
  assert.equal(r.target, 'src/lib/money.ts');
});

test('a package not in the repository is external, and a runtime module says so', () => {
  const root = writeRepo(REPO);
  const ctx = buildResolveContext(root, SOURCE_FILES);
  assert.equal(resolveWithContext(ctx, 'src/checkout/checkout.controller.ts', 'stripe').status, 'external');
  const fsMod = resolveWithContext(ctx, 'src/checkout/checkout.controller.ts', 'fs');
  assert.equal(fsMod.status, 'external');
  assert.match(fsMod.reason, /runtime/);
});

test('a relative import that resolves to nothing is unresolved, never dropped', () => {
  const root = writeRepo(REPO);
  const ctx = buildResolveContext(root, SOURCE_FILES);
  const r = resolveWithContext(ctx, 'src/checkout/checkout.controller.ts', './does-not-exist');
  // Dropping it would make the closure read complete when a path is missing from it.
  assert.equal(r.status, 'unresolved');
});

// ---------------------------------------------------------------------------
// edges
// ---------------------------------------------------------------------------

test('a commented-out call is not an edge, and line numbers do not shift', () => {
  const lines = [
    'const a = live();',
    '// const b = commented();',
    '/* const c = blockCommented(); */',
    'const d = alsoLive();',
  ];
  const stripped = stripComments(lines.join('\n'), { id: 'js' });
  const out = stripped.split('\n');

  // A commented call that survives becomes a boundary surface for code that does not run.
  assert.match(out[0], /live\(\)/);
  assert.doesNotMatch(out[1], /commented/);
  assert.doesNotMatch(out[2], /blockCommented/);
  assert.match(out[3], /alsoLive\(\)/);
  assert.equal(out.length, lines.length);
});

test('an import specifier inside a string literal survives comment stripping', () => {
  // String literals must NOT be blanked: every import specifier is one.
  const text = "import x from './keep-me';";
  assert.match(stripComments(text, { id: 'js' }), /keep-me/);
});

test('a declaration is not counted as a call', () => {
  assert.ok(declaresCallable('  async validate(code: string) {', 'validate'));
  assert.ok(declaresCallable('  private stack(x: number): number {', 'stack'));
  assert.ok(declaresCallable('  findByCode(code: string): Promise<T>;', 'findByCode'));
  assert.ok(declaresCallable('export function money(n: number) {', 'money'));
  // A real call must still read as a call.
  assert.ok(!declaresCallable('    return this.repo.findByCode(code);', 'findByCode'));
  assert.ok(!declaresCallable('    const v = validate(x);', 'validate'));
});

test('an injected field is mapped to its declared type', () => {
  const map = injectedFieldTypes([
    'constructor(private promos: PromoService, private pay: PaymentService) {}',
  ].join('\n'));
  // Without this, every DI-shaped codebase produces edges with no call sites.
  assert.equal(map.get('promos'), 'PromoService');
  assert.equal(map.get('pay'), 'PaymentService');
});

test('a file reports its imports, its call sites, and its injected field types', () => {
  const root = writeRepo(REPO);
  const r = extractEdges(root, 'src/checkout/checkout.controller.ts');

  assert.equal(r.language, 'js');
  assert.equal(r.imports.length, 3);
  assert.deepEqual(r.imports.map((i) => i.specifier).sort(), [
    '../payments/payment.service', '../promotions/promo.service', '@lib/money',
  ]);

  const validate = r.calls.find((c) => c.method === 'validate');
  assert.ok(validate, 'the service call must be found');
  assert.equal(validate.head, 'promos');
  assert.equal(validate.ref, 'src/checkout/checkout.controller.ts:7');

  assert.equal(r.fieldTypes.promos, 'PromoService');
});

test('a call name that is language noise is not an edge', () => {
  assert.ok(CALL_NOISE.has('map'));
  assert.ok(CALL_NOISE.has('toString'));
  assert.ok(!CALL_NOISE.has('validate'), 'a domain verb must never be filtered as noise');
});

// ---------------------------------------------------------------------------
// closure - the behaviour this whole engine exists for
// ---------------------------------------------------------------------------

test('a path scope is a seed, not a filter: the closure follows every internal callee', () => {
  const root = writeRepo(REPO);
  const r = walkClosure({ root, files: SOURCE_FILES, scope: 'src/checkout' });

  const reached = r.reached.files.map((f) => f.file);

  // THE point. A scope filter would return only the one seed file, and every service below it
  // would be tested as a black box. All four layers must be present.
  assert.ok(reached.includes('src/checkout/checkout.controller.ts'), 'seed');
  assert.ok(reached.includes('src/promotions/promo.service.ts'), 'depth 1 callee');
  assert.ok(reached.includes('src/payments/payment.service.ts'), 'depth 1 callee');
  assert.ok(reached.includes('src/promotions/promo.repo.ts'), 'depth 2 callee');
  assert.ok(reached.includes('src/lib/money.ts'), 'reached through a tsconfig alias');

  // And it must not become a whole-repo walk: an unrelated file stays out.
  assert.ok(!reached.includes('src/unrelated/thing.ts'), 'unrelated code must stay out of scope');

  assert.equal(r.reached.seeds, 1);
  assert.ok(r.reached.pulledIn >= 4);
});

test('depth records the shortest execution path to each file', () => {
  const root = writeRepo(REPO);
  const r = walkClosure({ root, files: SOURCE_FILES, scope: 'src/checkout' });
  const depth = new Map(r.reached.files.map((f) => [f.file, f.depth]));

  assert.equal(depth.get('src/checkout/checkout.controller.ts'), 0);
  assert.equal(depth.get('src/promotions/promo.service.ts'), 1);
  assert.equal(depth.get('src/promotions/promo.repo.ts'), 2);
});

test('an internal edge carries the call-site line, including through injection', () => {
  const root = writeRepo(REPO);
  const r = walkClosure({ root, files: SOURCE_FILES, scope: 'src/checkout' });

  const edge = r.internalEdges.find((e) => e.to === 
    'src/promotions/promo.service.ts' && e.from === 'src/checkout/checkout.controller.ts');
  assert.ok(edge, 'the controller-to-service edge must exist');

  // The call reads `this.promos.validate(..)` and the import binds `PromoService`. Linking
  // them is what gives a test the line to drive and a failure the line to be injected at.
  assert.equal(edge.callSites.length, 1, 'the call site must be attributed through the field type');
  assert.match(edge.callSites[0].symbol, /validate/);
  assert.equal(edge.callSites[0].ref, 'src/checkout/checkout.controller.ts:7');
});

test('upstream callers are reported as blast radius without dragging in their own deps', () => {
  const root = writeRepo(REPO);
  const r = walkClosure({ root, files: SOURCE_FILES, scope: 'src/checkout', upstream: true });

  const admin = r.impactedByChange.find((i) => i.file === 'src/admin/admin.controller.ts');
  assert.ok(admin, 'a file calling into the closure must be reported as impacted');
  assert.equal(admin.reaches[0].target, 'src/promotions/promo.service.ts');

  // Impacted files are NOT closure members: pulling their dependencies in would walk the repo.
  const reached = r.reached.files.map((f) => f.file);
  assert.ok(!reached.includes('src/admin/admin.controller.ts'));
});

test('a depth limit truncates and SAYS SO, listing what was never explored', () => {
  const root = writeRepo(REPO);
  const r = walkClosure({ root, files: SOURCE_FILES, scope: 'src/checkout', maxDepth: 1 });

  assert.equal(r.incomplete.truncatedAtDepth, 1);
  assert.ok(r.incomplete.truncatedFrontier.length > 0);
  // The one property that must never be wrong: a truncated walk cannot read as complete.
  assert.equal(r.incomplete.isComplete, false);
});

test('an unresolvable edge is recorded as a gap rather than dropped', () => {
  const files = {
    ...REPO,
    'src/checkout/dyn.ts': [
      "import { A } from './nope';",
      'export async function load(n: string) { return import(n); }',
    ].join('\n'),
  };
  const root = writeRepo(files);
  const source = Object.keys(files).filter((f) => languageOf(f) !== null);
  const r = walkClosure({ root, files: source, scope: 'src/checkout' });

  assert.equal(r.unresolvedEdges.length, 2);
  assert.ok(r.unresolvedEdges.some((u) => u.specifier === './nope'));
  assert.ok(r.unresolvedEdges.some((u) => u.specifier === null), 'a computed import is still an edge');
  assert.equal(r.incomplete.isComplete, false);
});

test('a scope that matches nothing is flagged, not run as an empty success', () => {
  const root = writeRepo(REPO);
  const r = walkClosure({ root, files: SOURCE_FILES, scope: 'src/does-not-exist' });
  assert.equal(r.scope.selectedNothing, true);
  assert.equal(r.reached.total, 0);
});

test('scope selection accepts full-repo, a path and a file list', () => {
  assert.equal(selectSeeds(SOURCE_FILES, 'full-repo').seeds.length, SOURCE_FILES.length);
  assert.equal(selectSeeds(SOURCE_FILES, 'src/checkout').seeds.length, 1);

  const list = selectSeeds(SOURCE_FILES, ['src/lib/money.ts', 'src/nope.ts']);
  assert.deepEqual(list.seeds, ['src/lib/money.ts']);
  assert.deepEqual(list.missing, ['src/nope.ts'], 'a named file that is absent must be reported');
});

test('a windows-style scope path is normalised', () => {
  assert.equal(normPath('src\\checkout\\'), 'src/checkout');
  assert.equal(normPath('./src/checkout'), 'src/checkout');
});

// ---------------------------------------------------------------------------
// boundary - what an unreadable dependency turns into
// ---------------------------------------------------------------------------

test('an unreadable dependency becomes a surface with named failure modes', () => {
  const root = writeRepo(REPO);
  const closure = walkClosure({ root, files: SOURCE_FILES, scope: 'src/checkout' });
  const boundaries = classifyBoundaries(closure);

  const stripe = boundaries.find((b) => b.specifier === 'stripe');
  assert.ok(stripe, 'the payment SDK must be a boundary');
  assert.equal(stripe.kind, 'EXT');
  assert.match(stripe.id, /^SF-EXT-\d{3}$/);
  assert.equal(stripe.role, 'payment');
  assert.equal(stripe.exercised, true);

  // This is what turns a black box into coverage: named, concrete failure modes rather than
  // the useless instruction to simulate an error.
  const modes = stripe.failureOutcomes.map((o) => o.id);
  assert.ok(modes.includes('declined'), 'the most important payment negative path');
  assert.ok(modes.includes('timeout'));
  assert.ok(stripe.failureOutcomes.every((o) => typeof o.description === 
    'string' && o.description.length > 0), 'every mode needs a description a tester can act on');

  // Addressed at its call site, which is where a test drives it.
  assert.deepEqual(stripe.callers, ['src/payments/payment.service.ts']);
  assert.ok(stripe.evidence.some((e) => /payment\.service\.ts:\d+$/.test(e)));
});

test('a boundary states the isolation a test driving it can honestly claim', () => {
  const root = writeRepo(REPO);
  const closure = walkClosure({ root, files: SOURCE_FILES, scope: 'src/checkout' });
  const boundaries = classifyBoundaries(closure);

  const stripe = boundaries.find((b) => b.specifier === 'stripe');
  const prisma = boundaries.find((b) => b.specifier === '@prisma/client');

  // A shared payment sandbox cannot run concurrently with itself; a row it created can.
  assert.match(stripe.isolation, /^exclusive:/);
  assert.match(prisma.isolation, /^mutates-record:/);
});

test('the minimum case count is one success plus one per failure mode, per caller', () => {
  const root = writeRepo(REPO);
  const closure = walkClosure({ root, files: SOURCE_FILES, scope: 'src/checkout' });
  const boundaries = classifyBoundaries(closure);

  for (const b of boundaries.filter((x) => x.exercised)) {
    assert.equal(b.minimumCases, b.callers.length * (1 + b.failureOutcomes.length));
  }

  const summary = summariseBoundaries(boundaries);
  assert.equal(summary.total, boundaries.length);
  assert.ok(summary.minimumCases > 0);
  // The headline finding: a scope filter would have reported none of these.
  assert.ok(summary.exercised >= 2);
});

test('a dependency imported but never called is reported unexercised, not covered', () => {
  const files = {
    ...REPO,
    'src/checkout/unused.ts': "import axios from 'axios';\nexport const x = 1;",
  };
  const root = writeRepo(files);
  const source = Object.keys(files).filter((f) => languageOf(f) !== null);
  const closure = walkClosure({ root, files: source, scope: 'src/checkout/unused.ts' });
  const boundaries = classifyBoundaries(closure);

  const axios = boundaries.find((b) => b.specifier === 'axios');
  assert.equal(axios.exercised, false);
  // Zero, so it is never silently counted as covered.
  assert.equal(axios.minimumCases, 0);
});

test('a boundary id slug is stable and readable', () => {
  assert.equal(slugFor('@aws-sdk/client-sqs'), 'AWS-SDK-CLIENT-SQS');
  assert.equal(slugFor('stripe'), 'STRIPE');
});

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

test('the markdown carries the machine-read markers and the closure numbers', () => {
  const root = writeRepo(REPO);
  const closure = walkClosure({ root, files: SOURCE_FILES, scope: 'src/checkout' });
  const boundaries = classifyBoundaries(closure);
  const md = renderClosureMarkdown({
    ...closure,
    census: { sourceFiles: SOURCE_FILES.length },
    boundaries,
    boundarySummary: summariseBoundaries(boundaries),
  });

  // The exporter and the skills read these tables by marker, as everywhere else in the package.
  for (const marker of ['closure-files', 'closure-edges', 'closure-boundaries',
    'closure-impacted', 'closure-unresolved']) {
    assert.ok(md.includes('<!-- table:' + marker + ' -->'), 'missing marker: ' + marker);
  }

  assert.match(md, /# Dependency Closure/);
  assert.match(md, /seed, not a boundary/);
  assert.ok(md.includes('src/promotions/promo.repo.ts'), 'a depth-2 file must appear');
  assert.ok(md.includes('SF-EXT-'), 'boundary ids must appear');
  assert.match(md, /What Stage 1 must inventory/);
});

test('an incomplete closure renders its incompleteness before anything else', () => {
  const root = writeRepo(REPO);
  const closure = walkClosure({ root, files: SOURCE_FILES, scope: 'src/checkout', maxDepth: 1 });
  const boundaries = classifyBoundaries(closure);
  const md = renderClosureMarkdown({
    ...closure,
    census: { sourceFiles: SOURCE_FILES.length },
    boundaries,
    boundarySummary: summariseBoundaries(boundaries),
  });

  assert.match(md, /INCOMPLETE/);
  assert.match(md, /floor/);
  // It must come before the tables, so skimming cannot miss it.
  assert.ok(md.indexOf('INCOMPLETE') < md.indexOf('<!-- table:closure-files -->'));
});

test('a cell containing a pipe cannot break the table', () => {
  const { cell } = require('../render');
  assert.ok(!cell('a | b').includes('|'));
});
