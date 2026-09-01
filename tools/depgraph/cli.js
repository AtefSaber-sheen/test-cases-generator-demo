#!/usr/bin/env node
// Command-line front end for the dependency-graph engine.
//
// WHAT IT ANSWERS. Given a part of a system, what does that part actually execute, what calls
// into it, and which of its dependencies cannot be read and therefore have to be covered as
// boundaries? Run it before Stage 1 confirms surfaces: the closure decides which files Stage 1
// must inventory, and a scope-filtered inventory that ignores the closure is the thing this
// engine exists to prevent.
//
// Exit codes:
//   0  closure complete - every edge resolved, no cap hit
//   1  error - unreadable root, bad option, or a scope that selected nothing
//   2  closure INCOMPLETE - depth or file cap hit, or an edge could not be resolved. The result
//      is then a floor on what the scope reaches, and the caller must say so rather than claim
//      complete coverage.

'use strict';

const fs = require('fs');
const path = require('path');

// Newline, named so no string emitted by this file carries an ambiguous escape sequence.
const NL = String.fromCharCode(10);

const { walkClosure, DEFAULT_MAX_DEPTH, DEFAULT_MAX_FILES } = require('./closure');
const { classifyBoundaries, summariseBoundaries } = require('./boundary');
const { languageOf } = require('./languages');
const { walk, readGitignoreDirs } = require('../recon_scan/scan');
const { renderClosureMarkdown } = require('./render');

const USAGE = [
  'testgen-depgraph - what a part of a system actually executes',
  '',
  'USAGE',
  '  node tools/depgraph/cli.js --repo <path> [--scope <spec>] [options]',
  '',
  'OPTIONS',
  '  --repo <path>       Repository to analyse (default: current directory)',
  '  --scope <spec>      full-repo (default), a path (src/checkout), or a comma-separated file',
  '                      list. A path scope is a SEED, not a filter: everything it reaches is',
  '                      followed, because a callee inside the repo is readable and therefore',
  '                      part of the execution coverage of the part under test.',
  '  --depth <n>         How many hops of callees to follow (default: DEPTH_DEFAULT)',
  '  --max-files <n>     Cap on files examined (default: FILES_DEFAULT)',
  '  --no-upstream       Skip the caller / blast-radius pass',
  '  --out <dir>         Write depgraph.json and DependencyClosure.md here',
  '  --json              Print the full JSON report to stdout',
  '  --quiet             Suppress the prose summary',
  '',
  'WHAT THE OUTPUT IS',
  '  A floor, never a ceiling. Edges come from import syntax and call-site text, so an edge',
  '  created by injection through a token, by reflection, or by a computed import is not visible.',
  '  Every such place that IS detectable is listed under unresolvedEdges; treat that list as the',
  '  known hole in the graph rather than evidence there is none.',
]
  .join(String.fromCharCode(10))
  .replace('DEPTH_DEFAULT', String(DEFAULT_MAX_DEPTH))
  .replace('FILES_DEFAULT', String(DEFAULT_MAX_FILES));
function parseArgs(argv) {
  const opts = {
    repo: process.cwd(),
    scope: null,
    depth: DEFAULT_MAX_DEPTH,
    maxFiles: DEFAULT_MAX_FILES,
    upstream: true,
    out: null,
    json: false,
    quiet: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(arg + ' requires a value');
      i += 1;
      return value;
    };

    switch (arg) {
      case '--repo': opts.repo = next(); break;
      case '--scope': opts.scope = next(); break;
      case '--depth': opts.depth = Number(next()); break;
      case '--max-files': opts.maxFiles = Number(next()); break;
      case '--no-upstream': opts.upstream = false; break;
      case '--out': opts.out = next(); break;
      case '--json': opts.json = true; break;
      case '--quiet': opts.quiet = true; break;
      case '-h': case '--help': opts.help = true; break;
      default:
        if (arg.startsWith('--')) throw new Error('Unknown option ' + arg);
        opts.repo = arg;
    }
  }

  if (!Number.isFinite(opts.depth) || opts.depth < 0) throw new Error('--depth must be a non-negative number');
  if (!Number.isFinite(opts.maxFiles) || opts.maxFiles < 1) throw new Error('--max-files must be a positive number');
  return opts;
}

/**
 * A scope spec on the command line is a string; a comma means a file list.
 *
 * Kept here rather than in closure.js so the library takes structured input and only the CLI
 * deals in shell ergonomics.
 */
function parseScope(spec) {
  if (!spec) return null;
  if (spec.includes(',')) {
    return spec.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return spec;
}

/**
 * Collect the source files the graph can walk.
 *
 * Reuses the recon scanner walker so the two tools agree on what counts as a source file and on
 * what is skipped. Two tools with two different denominators would make the closure and the
 * surface inventory impossible to reconcile.
 */
function collectFiles(root) {
  const ignoreDirs = readGitignoreDirs(root);
  const { files, skipped, dirCount } = walk(root, { ignoreDirs });
  const source = files.filter((f) => languageOf(f) !== null);
  return { files: source, allFiles: files, skipped, dirCount };
}
function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(err.message + NL + NL + USAGE + NL);
    return 1;
  }
  if (opts.help) {
    process.stdout.write(USAGE + NL);
    return 0;
  }

  const root = path.resolve(opts.repo);
  if (!fs.existsSync(root)) {
    process.stderr.write('No such directory: ' + root + NL);
    return 1;
  }

  const census = collectFiles(root);
  const scope = parseScope(opts.scope);

  const closure = walkClosure({
    root,
    files: census.files,
    scope,
    maxDepth: opts.depth,
    maxFiles: opts.maxFiles,
    upstream: opts.upstream,
  });

  // A scope that matched nothing is an error, not an empty result. It is almost always a mistyped
  // path, and an empty closure reported as success is the worst answer this tool could give.
  if (closure.scope.selectedNothing) {
    process.stderr.write(
      'Scope matched no source file: ' + JSON.stringify(opts.scope) + NL + 'Searched ' + census.files.length + ' source files under ' + root + NL
    );
    return 1;
  }

  const boundaries = classifyBoundaries(closure);
  const boundarySummary = summariseBoundaries(boundaries);

  const report = {
    ...closure,
    census: {
      sourceFiles: census.files.length,
      allFiles: census.allFiles.length,
      directories: census.dirCount,
      skipped: census.skipped,
    },
    boundaries,
    boundarySummary,
  };

  if (opts.out) {
    fs.mkdirSync(opts.out, { recursive: true });
    const jsonPath = path.join(opts.out, 'depgraph.json');
    const mdPath = path.join(opts.out, 'DependencyClosure.md');
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + NL, 'utf8');
    fs.writeFileSync(mdPath, renderClosureMarkdown(report), 'utf8');
    if (!opts.quiet) {
      process.stdout.write('wrote ' + path.relative(process.cwd(), jsonPath) + NL);
      process.stdout.write('wrote ' + path.relative(process.cwd(), mdPath) + NL);
    }
  }

  if (opts.json) process.stdout.write(JSON.stringify(report, null, 2) + NL);

  if (!opts.quiet && !opts.json) {
    process.stdout.write(renderSummary(report) + NL);
  }

  return report.incomplete.isComplete ? 0 : 2;
}
/**
 * The terminal summary.
 *
 * Every number here has a denominator, and the incompleteness line is never omitted when it
 * applies: a reader of this summary alone must not be able to mistake a truncated walk for a
 * complete one.
 */
function renderSummary(report) {
  const s = report.scope;
  const r = report.reached;
  const b = report.boundarySummary;
  const out = [];

  out.push("scope:      " + s.kind + " " + s.spec + " (" + s.seedCount + " seed file(s))");
  out.push(
    "reached:    " + r.total + " file(s) of " + report.census.sourceFiles + " source files"
    + " (" + r.seeds + " seed + " + r.pulledIn + " pulled in),"
    + " max depth " + report.limits.depthReached + " of " + report.limits.maxDepth
  );
  out.push("edges:      " + report.internalEdges.length + " internal import edge(s)");
  out.push(
    "boundaries: " + b.total + " unreadable dependenc(ies), " + b.exercised + " exercised,"
    + " at least " + b.minimumCases + " boundary case(s) to cover"
  );
  out.push(
    "impacted:   " + report.impactedByChange.length
    + " file(s) outside the closure call into it"
  );

  if (b.byRole.length) {
    out.push("  by role:  " + b.byRole.map((x) => x.role + "=" + x.count).join("  "));
  }

  if (!report.incomplete.isComplete) {
    const why = [];
    if (report.incomplete.truncatedAtDepth !== null) {
      why.push(
        "stopped at depth " + report.incomplete.truncatedAtDepth
        + " with " + report.incomplete.truncatedFrontier.length + " file(s) unexplored"
      );
    }
    if (report.incomplete.cappedAtFiles) why.push("file cap reached");
    if (report.unresolvedEdges.length) {
      why.push(report.unresolvedEdges.length + " edge(s) not resolvable from source");
    }
    if (report.incomplete.skippedFiles.length) {
      why.push(report.incomplete.skippedFiles.length + " file(s) unread");
    }
    out.push(
      "INCOMPLETE: " + why.join("; ")
      + ". This closure is a floor on what the scope reaches, not the whole picture."
    );
  }

  return out.join(NL);
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main, parseArgs, parseScope, collectFiles, renderSummary };
