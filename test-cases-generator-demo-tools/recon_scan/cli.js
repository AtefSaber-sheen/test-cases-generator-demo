#!/usr/bin/env node
// Command-line front end for the static recon scanner.
//
// Exit codes:
//   0  scan completed
//   1  error — unreadable root, bad option
//   2  scan completed but something was NOT searched (unreadable paths, or a detector was capped),
//      so the inventory is incomplete and the caller should say so rather than claim full coverage

'use strict';

const fs = require('fs');
const path = require('path');

const { scan, DEFAULT_MAX_HITS_PER_DETECTOR, DEFAULT_MAX_FILE_BYTES } = require('./scan');

const USAGE = `
testgen-scan — static inventory of a codebase, for test design

USAGE
  node test-cases-generator-demo-tools/recon_scan/cli.js --repo <path> [options]

OPTIONS
  --repo <path>          Repository to scan (default: current directory)
  --out <dir>            Write recon_scan.json and ReconScan.md here (default: print only)
  --kind <K[,K...]>      Only report these surface kinds (API, UI, JOB, MSG, CLI, RULE, AUTH, DB, CFG)
  --max-hits <n>         Per-detector hit cap (default: ${DEFAULT_MAX_HITS_PER_DETECTOR})
  --max-file-bytes <n>   Skip files larger than this (default: ${DEFAULT_MAX_FILE_BYTES})
  --json                 Print the full JSON report to stdout
  --quiet                Suppress the prose summary

WHAT THE OUTPUT IS
  Candidates, not conclusions. Every hit names a file and a line to READ. A pattern cannot tell a
  live route from a commented-out one, so nothing here becomes a surface or a test case until it
  has been confirmed in the source.
`.trim();

function parseArgs(argv) {
  const opts = {
    repo: process.cwd(),
    out: null,
    kinds: null,
    maxHitsPerDetector: DEFAULT_MAX_HITS_PER_DETECTOR,
    maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    json: false,
    quiet: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      i += 1;
      return value;
    };

    switch (arg) {
      case '--repo': opts.repo = next(); break;
      case '--out': opts.out = next(); break;
      case '--kind': opts.kinds = next().split(',').map((k) => k.trim().toUpperCase()); break;
      case '--max-hits': opts.maxHitsPerDetector = Number(next()); break;
      case '--max-file-bytes': opts.maxFileBytes = Number(next()); break;
      case '--json': opts.json = true; break;
      case '--quiet': opts.quiet = true; break;
      case '-h': case '--help': opts.help = true; break;
      default:
        if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}`);
        opts.repo = arg;
    }
  }
  return opts;
}

function table(headers, rows) {
  const out = [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`];
  for (const row of rows) {
    out.push(`| ${row.map((c) => String(c === undefined ? '' : c).replace(/\|/g, '\\|')).join(' | ')} |`);
  }
  return out.join('\n');
}

/**
 * Render the scan as Markdown.
 *
 * The candidate list is grouped by KIND rather than by file, because the reading that follows is
 * organised by surface type: all the routes, then all the validation rules, then all the guards.
 */
function renderMarkdown(report) {
  const lines = [];
  const c = report.census;

  lines.push('# Recon Scan');
  lines.push('');
  lines.push(`**Root:** \`${report.root}\`  `);
  lines.push(`**Files:** ${c.files} in ${c.directories} directories — `
    + `${c.sourceFilesScanned} searched, ${c.testFiles} existing test files, `
    + `${c.schemaFiles} schema/migration files`);
  lines.push('');
  lines.push('> Everything under **Candidate Surfaces** is a candidate produced by pattern');
  lines.push('> matching. It names a place to read, not a behaviour that exists. Confirm each in');
  lines.push('> the source before it becomes a surface, a rule, or a test case.');
  lines.push('');

  lines.push('## Stack');
  lines.push('');
  if (report.stack.signals.length) {
    lines.push(table(
      ['Role', 'Detected', 'Declared as'],
      report.stack.signals.map((s) => [s.role, s.label, s.matched.slice(0, 6).join(', ')])
    ));
  } else {
    lines.push('_No known framework signals found in the manifests._');
  }
  lines.push('');
  lines.push(`Manifests read: ${report.stack.manifests.map((m) => `\`${m.manifest}\``).join(', ') || 'none'}`);
  lines.push('');

  lines.push('## Candidate modules');
  lines.push('');
  lines.push(report.modules.length
    ? table(['Module', 'Files'], report.modules.slice(0, 30).map((m) => [`\`${m.name}\``, m.fileCount]))
    : '_No module boundaries inferred._');
  if (report.modules.length > 30) {
    lines.push('');
    lines.push(`_${report.modules.length - 30} smaller groupings not listed._`);
  }
  lines.push('');

  lines.push('## Candidate surfaces');
  lines.push('');
  const byKind = report.candidateSurfaces.byKind;
  lines.push(Object.keys(byKind).length
    ? table(['Kind', 'Hits'], Object.entries(byKind).sort((a, b) => b[1] - a[1]))
    : '_No candidates matched._');
  lines.push('');

  const grouped = new Map();
  for (const hit of report.candidateSurfaces.hits) {
    if (!grouped.has(hit.kind)) grouped.set(hit.kind, []);
    grouped.get(hit.kind).push(hit);
  }
  for (const [kind, hits] of [...grouped.entries()].sort()) {
    lines.push(`### ${kind} (${hits.length})`);
    lines.push('');
    lines.push(table(
      ['Location', 'Detector', 'Line'],
      hits.map((h) => [`\`${h.ref}\``, h.label, `\`${h.snippet}\``])
    ));
    lines.push('');
  }

  if (report.candidateSurfaces.truncated.length) {
    lines.push('### Truncated detectors — these lists are INCOMPLETE');
    lines.push('');
    lines.push(table(
      ['Detector', 'Hits dropped', 'Cap'],
      report.candidateSurfaces.truncated.map((t) => [t.detector, t.dropped, t.cap])
    ));
    lines.push('');
  }

  lines.push('## Not searched');
  lines.push('');
  lines.push(`_${report.skipped.note}_`);
  lines.push('');
  const skipRows = [];
  if (report.skipped.ignoredDirectories.length) {
    skipRows.push(['Ignored directories', report.skipped.ignoredDirectories.length,
      report.skipped.ignoredDirectories.slice(0, 12).join(', ')]);
  }
  if (report.skipped.binaryOrAssetFiles) {
    skipRows.push(['Binary / asset files', report.skipped.binaryOrAssetFiles, '']);
  }
  if (report.skipped.tooLarge.length) {
    skipRows.push(['Too large', report.skipped.tooLarge.length,
      report.skipped.tooLarge.slice(0, 8).map((t) => t.path).join(', ')]);
  }
  if (report.skipped.unreadable.length) {
    skipRows.push(['Unreadable', report.skipped.unreadable.length,
      report.skipped.unreadable.slice(0, 8).map((t) => t.path).join(', ')]);
  }
  lines.push(skipRows.length ? table(['Reason', 'Count', 'Examples'], skipRows) : '_Nothing skipped._');
  lines.push('');

  lines.push('## Existing tests');
  lines.push('');
  lines.push(`_${report.existingTests.note}_`);
  lines.push('');
  lines.push(report.existingTests.files.length
    ? report.existingTests.files.slice(0, 60).map((f) => `- \`${f}\``).join('\n')
    : '_None found._');
  if (report.existingTests.files.length > 60) {
    lines.push('');
    lines.push(`_${report.existingTests.files.length - 60} more not listed._`);
  }
  lines.push('');

  lines.push('## Schema and migration sources');
  lines.push('');
  lines.push(report.schemaSources.length
    ? report.schemaSources.slice(0, 60).map((f) => `- \`${f}\``).join('\n')
    : '_None found._');
  lines.push('');

  return `${lines.join('\n')}\n`;
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${USAGE}\n`);
    return 1;
  }
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  let report;
  try {
    report = scan(opts.repo, {
      maxHitsPerDetector: opts.maxHitsPerDetector,
      maxFileBytes: opts.maxFileBytes,
    });
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 1;
  }

  if (opts.kinds) {
    report.candidateSurfaces.hits = report.candidateSurfaces.hits
      .filter((h) => opts.kinds.includes(h.kind));
    report.candidateSurfaces.filteredTo = opts.kinds;
  }

  if (opts.out) {
    fs.mkdirSync(opts.out, { recursive: true });
    const jsonPath = path.join(opts.out, 'recon_scan.json');
    const mdPath = path.join(opts.out, 'ReconScan.md');
    fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    fs.writeFileSync(mdPath, renderMarkdown(report), 'utf8');
    if (!opts.quiet) {
      process.stdout.write(`wrote ${path.relative(process.cwd(), jsonPath)}\n`);
      process.stdout.write(`wrote ${path.relative(process.cwd(), mdPath)}\n`);
    }
  }

  if (opts.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  const incomplete = report.candidateSurfaces.truncated.length > 0
    || report.skipped.unreadable.length > 0;

  if (!opts.quiet && !opts.json) {
    const c = report.census;
    const kinds = Object.entries(report.candidateSurfaces.byKind)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k}=${n}`)
      .join('  ');
    process.stdout.write(
      `scanned ${c.sourceFilesScanned}/${c.files} files in ${c.directories} directories\n`
      + `stack:   ${report.stack.signals.map((s) => s.label).join(', ') || '(none detected)'}\n`
      + `surfaces: ${kinds || '(none)'}\n`
      + `tests:   ${c.testFiles} existing test file(s)\n`
    );
    if (incomplete) {
      process.stdout.write(
        'INCOMPLETE: some paths were not searched or a detector hit its cap — see the report.\n'
      );
    }
  }

  return incomplete ? 2 : 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main, parseArgs, renderMarkdown };
