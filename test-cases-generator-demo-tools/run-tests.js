#!/usr/bin/env node
// Test runner.
//
// WHY THIS EXISTS RATHER THAN A BARE `node --test`. Two reasons, both about not lying.
//
// 1. File discovery differs across Node majors, and glob arguments (`--test 'a/**/*.test.js'`) are
//    supported from Node 22 but not 18. Whichever form is chosen, a version that discovers nothing
//    exits 0 — a green build that ran no tests. That is the worst possible failure mode for a
//    package whose entire argument is "the numbers mean something".
//
// 2. So this discovers the files itself, ASSERTS it found the expected minimum, and only then
//    hands an explicit file list to `node --test`. A test file that stops being discovered fails
//    the run instead of vanishing from it.

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Raise this when a test file is added. It is a floor, not a target: its whole job is to turn
// "discovery silently found nothing" into a failure.
const MINIMUM_TEST_FILES = 2;

function findTestFiles(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) findTestFiles(abs, found);
    else if (/\.test\.c?js$/.test(entry.name)) found.push(abs);
  }
  return found;
}

const files = findTestFiles(path.join(ROOT, 'test-cases-generator-demo-tools')).sort();

if (files.length < MINIMUM_TEST_FILES) {
  process.stderr.write(
    `Discovered only ${files.length} test file(s); expected at least ${MINIMUM_TEST_FILES}.\n`
    + 'Either a test file was deleted, or discovery is broken on this Node version. Refusing to\n'
    + 'report a pass for a run that did not execute the suite.\n'
    + files.map((f) => `  ${path.relative(ROOT, f)}\n`).join('')
  );
  process.exit(1);
}

const extraArgs = process.argv.slice(2);
const result = spawnSync(
  process.execPath,
  ['--test', ...extraArgs, ...files],
  { stdio: 'inherit', cwd: ROOT }
);

if (result.error) {
  process.stderr.write(`${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
