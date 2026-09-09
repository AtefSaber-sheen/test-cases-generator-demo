---
name: suite-export
description: Stage 4 of test generation from a codebase alone. Writes the two - and only two - deliverables of the whole pipeline: one CSV holding every test case with its full execution procedure, and one Markdown report holding coverage, gaps, assumptions, traceability, test data, execution profile and warnings. Everything the earlier stages produced is held in context and rendered here; no intermediate file is ever written to disk. Use to produce the final deliverable once test-design-from-code has designed the suite.
inputs:
  - { name: designed_suite, type: in_context, required: true, description: "Stage 3 cases, test data, execution profile, traceability and coverage, plus Stage 1 surfaces and Stage 2 rules/contracts/gaps. Held in context, NOT read from disk." }
  - { name: scope, type: string, required: true, description: The scope name, used for both filenames (e.g. Checkout). }
  - { name: out_dir, type: directory_path, required: true, description: Where the two deliverables are written. Nothing else is written there. }
outputs:
  - { name: test_cases_csv, type: file_path, location: "{{OUT}}/TestCases_{{SCOPE}}.csv", description: Every case in the scope, one row each, with the full procedure. RFC 4180. The file a tester runs from. }
  - { name: test_report_md, type: file_path, location: "{{OUT}}/TestReport_{{SCOPE}}.md", description: Everything that is not a case row - coverage against both denominators, gaps, assumptions, traceability, test data, execution profile, parallel plan, warnings. }
dependencies:
  - test-design-from-code (upstream skill)
---

> Stage 4 of 4 — `codebase-recon` → `behavior-spec` → `test-design-from-code` → **`suite-export`**.

## The rule this stage exists to enforce

**A run produces exactly two files. Nothing else reaches disk.** Stages 1-3 do all their work in context and it is rendered once, here.

Earlier versions wrote a dozen intermediate Markdown documents, a workbook and a JSON contract: a reviewer opened eight files to answer one question, and the same fact existed in three renderings that could disagree. So **do not write** `SurfaceInventory.md`, `UseCaseCatalog.md`, `BusinessRules.md`, `DataContracts.md`, `Gaps.md`, `TestCases_*.md`, `TestData_*.md`, `ExecutionProfile_*.md`, `TraceabilityMatrix.md`, `CoverageReport.md`, any `.xlsx`, or any `testsuite.json`. **Their content is not discarded — every one has a destination section below. What is dropped is the file, not the fact.** A scratch file is acceptable only if the case volume genuinely will not fit in context, and it is deleted before this stage returns: a leftover scratch file is a failed run.

Where each former document now lives: `SurfaceInventory.md`, `UseCaseCatalog.md`, `BusinessRules.md`, `DataContracts.md` → section 12 · `Gaps.md` → 13 · `DependencyClosure.md` → 6 · `TestData_*.md` → 9 · `ExecutionProfile_*.md` → 10 · `TraceabilityMatrix.md` → 8 · `CoverageReport.md` → 3, 4, 5 and 7 · workbook Summary sheet → 1 and 14 · workbook Parallel Plan sheet → 11 · `testsuite_*.json` → 10 and 11 · `codemap.lock.json` → dropped (drift detection needed a committed baseline; section 6 records the commit the suite was derived from, which is what a re-run compares against).

## TestCases_{{SCOPE}}.csv — the file a tester runs from

One header row, then one row per case, in the twelve-column order the pipeline has always used plus the three execution columns a tester needs to run the case:

```
Test Case ID,Module,Title,Objective,Preconditions,Test Data,Steps,Expected Result,Priority,Tags,Layer,Entry Point,Oracle,Notes,Review,Automation
```

**Test Case ID** `TC-<MODULE>-<NNN>`, stable across re-runs; retire, never reuse. **Module** mandatory — what the tester filters on, a column here because there is only one file; a blank is a warning. **Title** short, specific, scannable. **Objective** one sentence. **Preconditions** only what must be true immediately before step 1. **Test Data** the concrete values the steps reference, one `field = value` per line, never "a valid X". **Steps** the full procedure, one action per numbered line, actions only. **Expected Result** the observable outcome constituting a pass: status, code, value, postcondition. **Priority** `P1`-`P4`. **Tags** exactly one granularity tier (`Atomic`/`Scenario`/`E2E`) plus the test types. **Layer** `API`, `UI`, `E2E` or `Contract`, nothing else. **Entry Point** exactly how the case is addressed: method+path, route, command, topic. **Oracle** `HTTPStatus`/`JSONBody`/`SchemaMatch`/`DBState`/`EventEmitted`/`LogEntry`/`UIAssertion`/`Snapshot`, combined with `+`. **Notes** genuinely useful context only, naming the gap for any assumption-derived case. **Review** and **Automation** literally `Pending`, never anything else.

**RFC 4180, and it matters** — the procedure is the point of the file, so it must survive the trip into a spreadsheet intact. Quote any field containing a comma, a double quote or a newline (in practice: quote Steps, Test Data, Preconditions and Expected Result essentially always). Escape an embedded double quote by **doubling** it, never with a backslash. **Keep real newlines inside the quoted field** — `Steps` is a numbered list on separate lines within one cell, which Excel, Sheets and LibreOffice all render as a wrapped multi-line cell; flattening the procedure onto one line with `|` separators produces a cell nobody can read, and the procedure is the deliverable. **CRLF between records, UTF-8 with a BOM** — the BOM is what makes Excel open accented Latin and CJK test data correctly instead of as mojibake, and the suite deliberately contains Unicode test data. **Never let a value be coerced**: `TC-CHK-002` is safe but a bare `1.10` becomes a date in Excel, so keep it quoted and state the intended type in the cell — `1.10 (string)`.

A correctly quoted multi-line row, with numbered steps on their own lines inside one cell:

```csv
TC-CHK-002,Checkout,"Reject a promo code past its expiry date","Verify that an expired promo code is rejected and leaves the total unchanged.","A cart containing one item priced 100.00 exists for an authenticated customer.","promoCode = WINTER5
expiresAt = 2025-01-31T23:59:59Z (past)","1. Submit the cart to POST /api/checkout.
2. Supply the promo code WINTER5.","The request is rejected with HTTP 422 and error code PROMO_EXPIRED; the payable total is unchanged at 100.00 and no order row is created.",P2,"Atomic, Negative-Temporal, BusinessRule",API,POST /api/checkout,HTTPStatus + JSONBody,"Expiry is compared against server time, not client time.",Pending,Pending
```

**Cases are ordered by module, then by ID**, so the file reads in the grouped order Stage 3 produced and a filtered view stays coherent.

## TestReport_{{SCOPE}}.md — everything else

The CSV answers "what do I run"; this answers what a reviewer, a lead or an automation engineer needs. Write these fourteen sections in order:

1. **Summary** — scope, repo, commit, generation date, total cases, counts by module / priority / tier / layer / test type
2. **How to use these two files** — one paragraph: the CSV is the executable suite, this is the evidence and the argument
3. **Coverage, the two denominators** — surfaces covered and **flows covered** side by side, each with numerator, denominator and percentage
4. **Coverage status table** — per item: ID, type, status, case IDs, reason, `path:line`
5. **Evaluation grid** — surface × test type, and flow × journey type, every cell a case ID or `Not Applicable - reason`
6. **Execution closure and boundaries** — seed vs reached, depth walked, per boundary modes covered / possible, impacted callers, unresolved edges, and the commit the suite was derived from
7. **Unreachable-Black-Box items** — rules no surface reaches, with `path:line` and what would have to exist to test them
8. **Traceability matrix** — case to module / use case / rule / surface / `path:line` / risk / confidence
9. **Test data** — one row per field per dataset: dataset ID, case ID, purpose, field, value, value kind, evidence
10. **Execution profile** — case ID, fixtures, teardown, isolation, parallel group, deterministic, est. runtime, automation notes
11. **Parallel plan** — the isolation groups, their mode, shared resource and case IDs, plus max useful workers
12. **Specification extract** — surfaces, use cases, business rules and data contracts, each row with `path:line` and confidence
13. **Gaps and assumptions** — every open question, the assumption taken, and which cases rest on it
14. **Warnings** — the full list from the checks below; `None - every case passed every check.` when clean

Sections 4, 8, 9, 10 and 12 are tables, and a table is preferred wherever it fits: this report is looked things up in, not read front to back. **A section is never omitted for being empty** — write the heading and one line saying it is empty and why. A missing section reads as an oversight; "No unresolved edges - every import resolved" is a finding.

**The join is what makes the pair trustworthy.** Every case ID in the CSV appears in the report's traceability table with a `path:line`, and every case ID there exists in the CSV. The two files join on Test Case ID, and a case in one but not the other is a warning meaning the pair was assembled inconsistently.

**Parallel plan**, derived from each case's isolation: `read-only` → group `read-only`, parallel · `shared-fixture:<name>` → that fixture, parallel within group · `mutates-record:<entity>` → that entity, parallel within group · `exclusive:<resource>` → that resource, serial on it · `global-state` → runs alone. **An absent or unrecognised isolation value is scheduled `exclusive`, and warned about** — the safe direction, since guessing "probably parallel-safe" from a blank buys a fast suite that fails intermittently, and an intermittent failure costs more than the serial run it avoided.

## The checks — run every one before writing

The mechanical exporter that used to enforce these is gone, so **you** enforce them. Check every case against every row and put every failure in the report's Warnings section, naming the case and the field. **Do not silently fix a case to clear a warning, and do not omit the warning** — the warning is the finding, and relabelling `Unit` as `API` leaves steps the tester still cannot run.

1. Every case has a non-empty **Expected Result** — one without is unexecutable, and shipping it silently is how it reaches a runner
2. Every case's **Layer** is `API`, `UI`, `E2E` or `Contract` — a `Unit`/`Component` case asks for a harness the tester lacks, so they skip it, and a skipped case still counts as coverage; the fix is to drive the rule through a surface that reaches it or record it `Unreachable-Black-Box`, never to relabel it
3. Every case has a non-empty **Module** — an unattributed case is missing from every per-module total while inflating the overall one
4. Every case has a **traceability row with a `path:line`** — a case whose expected result traces to nothing asserts an opinion
5. Every case ID in the CSV is in the report and vice versa — the two files join on this
6. Every case has exactly one granularity tier tag — tier drives the section 1 counts
7. Every case has a recognised **Isolation** value — an unrecognised one is scheduled `exclusive` and warned, never assumed parallel-safe
8. **Review** and **Automation** are literally `Pending` on every row — a suite that advances its own review status has reviewed its own work
9. Every value is **concrete** — no "a valid X", no "an invalid Y"; a runner cannot resolve a description
10. Every evaluation-grid cell is a case ID or `Not Applicable - reason` — a blank cell is an unfalsifiable completeness claim
11. Every CSV field needing quotes **is** quoted and embedded quotes are doubled — one unquoted comma shifts every later column on that row and corrupts the file silently
12. No intermediate file was left on disk

Report the counts plainly when you finish: cases written, warnings raised, and the two file paths. **If any check failed, say so in the response as well as in the report** — a warning that exists only in a file is one the person who ran the pipeline never sees.

**Never:** write the old intermediate Markdown "as well, just in case" (a dozen files that must agree is the problem this replaced) · drop a section because its source document no longer exists · flatten Steps onto one line to avoid quoting · omit the BOM · silently fix a case to avoid a warning · write `Review: Approved` (only a human moves that column) · emit the CSV without the report (alone it is a list of assertions with no evidence, no denominator and no gaps) · leave a scratch file behind.
