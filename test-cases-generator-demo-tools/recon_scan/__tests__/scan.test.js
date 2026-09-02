'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { scan, inferModules, extensionOf, readGitignoreDirs } = require('../scan');
const { renderMarkdown } = require('../cli');

/** A small but multi-ecosystem repository, so one scan exercises several detector families. */
const REPO = {
  'package.json': JSON.stringify({
    name: 'shop',
    dependencies: { express: '^4.18.0', zod: '^3.22.0', '@prisma/client': '^5.0.0' },
    devDependencies: { '@playwright/test': '^1.44.0', jest: '^29.0.0' },
  }, null, 2),
  '.gitignore': 'generated/\n*.log\n',
  'src/routes/orders.js': [
    "const router = require('express').Router();",
    "router.get('/orders', listOrders);",
    "router.post('/orders', createOrder);",
    'module.exports = router;',
  ].join('\n'),
  'src/routes/admin.js': [
    "router.delete('/admin/orders/:id', requireAuth, deleteOrder);",
    'function requireAuth(req, res, next) {',
    "  if (!hasRole(req.user, 'admin')) throw new ForbiddenError('nope');",
    '  next();',
    '}',
  ].join('\n'),
  'src/schema/order.js': [
    "const { z } = require('zod');",
    'const OrderSchema = z.object({',
    '  quantity: z.number().min(1).max(99),',
    '  email: z.string().email(),',
    '});',
  ].join('\n'),
  'src/jobs/reconcile.py': [
    '@shared_task',
    'def reconcile_orders():',
    '    pass',
  ].join('\n'),
  'src/pages/Checkout.tsx': [
    'export default function Checkout() {',
    '  return <form onSubmit={handleSubmit}><input name="promo" /></form>;',
    '}',
  ].join('\n'),
  'prisma/schema.prisma': [
    'model Order {',
    '  id    String @id',
    '  email String @unique',
    '}',
  ].join('\n'),
  'src/routes/__tests__/orders.test.js': "test('lists orders', () => {});",
  'generated/client.js': "router.get('/should-not-be-scanned', noop);",
  'node_modules/lib/index.js': "router.get('/definitely-not', noop);",
};

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'testgen-scan-'));
  for (const [rel, content] of Object.entries(REPO)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return root;
}

function withRepo(fn) {
  const root = makeRepo();
  try {
    return fn(root, scan(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('extensionOf handles compound and missing extensions', () => {
  assert.strictEqual(extensionOf('a/b/c.blade.php'), '.blade.php');
  assert.strictEqual(extensionOf('a/b/c.TS'), '.ts');
  assert.strictEqual(extensionOf('Makefile'), '(none)');
});

test('reads simple directory entries out of .gitignore', () => {
  const root = makeRepo();
  try {
    const dirs = readGitignoreDirs(root);
    assert.ok(dirs.has('generated'));
    // A glob is deliberately not honoured — a half-implemented gitignore skips files silently.
    assert.ok(!dirs.has('*.log'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('node_modules and gitignored directories are skipped, and the skip is reported', () => {
  withRepo((root, report) => {
    const refs = report.candidateSurfaces.hits.map((h) => h.file);
    assert.ok(!refs.some((f) => f.startsWith('node_modules/')));
    assert.ok(!refs.some((f) => f.startsWith('generated/')));
    assert.ok(report.skipped.ignoredDirectories.includes('node_modules'));
    assert.ok(report.skipped.ignoredDirectories.includes('generated'));
  });
});

test('detects the declared stack from the manifest', () => {
  withRepo((root, report) => {
    const labels = report.stack.signals.map((s) => s.label);
    assert.ok(labels.includes('Express'));
    assert.ok(labels.includes('Zod'));
    assert.ok(labels.includes('Prisma'));
    assert.ok(labels.includes('Playwright'));
    assert.deepStrictEqual(report.stack.ecosystems, ['node']);
  });
});

test('finds routes, guards, validation, jobs, forms and DB constraints', () => {
  withRepo((root, report) => {
    const byDetector = report.candidateSurfaces.byDetector;
    assert.ok(byDetector['express-route'].total >= 3);
    assert.ok(byDetector['authz-check']);
    assert.ok(byDetector['schema-validation']);
    assert.ok(byDetector['inline-constraint']);
    assert.ok(byDetector['guard-clause']);
    assert.ok(byDetector['scheduled-job']);
    assert.ok(byDetector['ui-form']);
    assert.ok(byDetector['db-constraint']);
  });
});

test('every hit carries a file:line reference that can be opened', () => {
  withRepo((root, report) => {
    for (const hit of report.candidateSurfaces.hits) {
      assert.match(hit.ref, /^[^:]+:\d+$/);
      const lines = fs.readFileSync(path.join(root, hit.file), 'utf8').split('\n');
      assert.ok(hit.line >= 1 && hit.line <= lines.length, `${hit.ref} out of range`);
      // The recorded snippet is genuinely the line it points at.
      assert.strictEqual(lines[hit.line - 1].trim().slice(0, 180), hit.snippet);
    }
  });
});

test('existing tests are listed separately and never counted as product surfaces', () => {
  withRepo((root, report) => {
    assert.ok(report.existingTests.files.includes('src/routes/__tests__/orders.test.js'));
    assert.ok(!report.candidateSurfaces.hits.some((h) => h.inTestCode));
  });
});

test('schema and migration sources are collected as evidence for data-shaped tests', () => {
  withRepo((root, report) => {
    assert.ok(report.schemaSources.includes('prisma/schema.prisma'));
  });
});

test('a truncating cap is reported, never silent', () => {
  const root = makeRepo();
  try {
    const report = scan(root, { maxHitsPerDetector: 1 });
    assert.ok(report.candidateSurfaces.truncated.length > 0);
    const routes = report.candidateSurfaces.truncated.find((t) => t.detector === 'express-route');
    assert.ok(routes.dropped >= 1);
    assert.match(routes.note, /were NOT reported/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the census reports a denominator, so coverage of the search is checkable', () => {
  withRepo((root, report) => {
    assert.ok(report.census.files > 0);
    assert.ok(report.census.sourceFilesScanned > 0);
    assert.ok(report.census.sourceFilesScanned <= report.census.files);
    assert.strictEqual(report.census.testFiles, 1);
  });
});

test('inferModules prefers explicit monorepo containers over the top-level directory', () => {
  const modules = inferModules([
    'apps/web/src/a.ts', 'apps/web/src/b.ts',
    'apps/api/src/a.ts', 'apps/api/src/b.ts',
    'src/shared/x.ts', 'src/shared/y.ts',
  ]);
  const names = modules.map((m) => m.name);
  assert.ok(names.includes('apps/web'));
  assert.ok(names.includes('apps/api'));
  assert.ok(names.includes('src/shared'));
});

test('the Markdown report states that its findings are candidates, and lists what was skipped', () => {
  withRepo((root, report) => {
    const md = renderMarkdown(report);
    assert.match(md, /# Recon Scan/);
    assert.match(md, /candidate produced by pattern/);
    assert.match(md, /## Not searched/);
    assert.match(md, /## Existing tests/);
    assert.match(md, /src\/routes\/orders\.js:2/);
  });
});

test('a nonexistent root is an actionable error', () => {
  assert.throws(() => scan(path.join(os.tmpdir(), 'definitely-not-here-9f2a')), /No such directory/);
});
