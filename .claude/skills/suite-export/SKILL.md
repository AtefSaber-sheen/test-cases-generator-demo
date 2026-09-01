---
name: suite-export
description: Stage 4 of test generation from a codebase alone. Writes the two - and only two - deliverables of the whole pipeline: one CSV holding every test case with its full execution procedure, and one Markdown report holding coverage, gaps, assumptions, traceability, test data, execution profile and warnings. Everything the earlier stages produced is held in context and rendered here; no intermediate file is ever written to disk. Use to produce the final deliverable once test-design-from-code has designed the suite.
inputs:
  - name: designed_suite
    type: in_context
    required: true
    description: The Stage 3 output - cases, test data, execution profile, traceability, coverage, plus the Stage 1 surfaces and Stage 2 rules/contracts/gaps. Held in context, NOT read from disk.
  - name: scope
    type: string
    required: true
    description: The scope name, used for both filenames (e.g. Checkout).
  - name: out_dir
    type: directory_path
    required: true
    description: Where the two deliverables are written. Nothing else is written there.
outputs:
  - name: test_cases_csv
    type: file_path
    location: "{{OUT}}/TestCases_{{SCOPE}}.csv"
    description: Every case in the scope, one row each, with the full procedure. RFC 4180. The file a tester runs from.
  - name: test_report_md
    type: file_path
    location: "{{OUT}}/TestReport_{{SCOPE}}.md"
    description: Everything that is not a test case row - coverage against both denominators, gaps, assumptions, traceability, test data, execution profile, the parallel plan, and the warning list.
dependencies:
  - test-design-from-code (upstream skill)
---

> **Pipeline position:** Stage 4 of 4 - `codebase-recon` -> `behavior-spec` -> `test-design-from-code` -> **`suite-export`**.

# 1. The rule this stage exists to enforce

**A run produces exactly two files. Nothing else reaches disk.**

```
Stage 1 -+
Stage 2 -+- held in context --> TestCases_{{SCOPE}}.csv   (every case, full procedure)
Stage 3 -+                      TestReport_{{SCOPE}}.md   (everything else worth keeping)
```

Earlier versions of this pipeline wrote a dozen intermediate Markdown documents, a workbook and a
JSON contract. A reviewer then had to open eight files to answer one question, and the same fact
existed in three renderings that could disagree. The stages still do all of that work - they simply
carry it in context and render it once, here.

**Do not write `SurfaceInventory.md`, `UseCaseCatalog.md`, `BusinessRules.md`, `DataContracts.md`,
`Gaps.md`, `TestCases_*.md`, `TestData_*.md`, `ExecutionProfile_*.md`, `TraceabilityMatrix.md`,
`CoverageReport.md`, any `.xlsx`, or any `testsuite.json`.** Their content is not discarded - every
one of them has a destination section in the report (section 4). What is dropped is the file, not
the fact.

A scratch file is acceptable only if the volume of cases genuinely will not fit in context, and it
is deleted before the stage returns. A leftover scratch file is a failed run.

# 2. TestCases_{{SCOPE}}.csv - the file a tester runs from

One header row, then one row per case, in the twelve-column order the pipeline has always used,
plus the three execution columns a tester needs to actually run the case:

```
Test Case ID,Module,Title,Objective,Preconditions,Test Data,Steps,Expected Result,Priority,Tags,Layer,Entry Point,Oracle,Notes,Review,Automation
```

| Column | Content |
|---|---|
| **Test Case ID** | `TC-<MODULE>-<NNN>`. Stable across re-runs; retire, never reuse. |
| **Module** | Mandatory. This is what the tester filters on - it is a column here because there is only one file. A blank is a warning (section 5). |
| **Title** | Short, specific, scannable. |
| **Objective** | One sentence. |
| **Preconditions** | Only what must be true immediately before step 1. |
| **Test Data** | The concrete values the steps reference, one `field = value` per line. Never "a valid X". |
| **Steps** | The full procedure, one action per numbered line. Actions only - no verification. |
| **Expected Result** | The observable outcome that constitutes a pass: status, code, value, and postcondition. |
| **Priority** | `P1`-`P4`. |
| **Tags** | Exactly one granularity tier (`Atomic`/`Scenario`/`E2E`) plus the test types. |
| **Layer** | `API`, `UI`, `E2E` or `Contract`, and nothing else (section 5). |
| **Entry Point** | Exactly how the case is addressed: method+path, route, command, topic. |
| **Oracle** | How pass is decided: `HTTPStatus`, `JSONBody`, `SchemaMatch`, `DBState`, `EventEmitted`, `LogEntry`, `UIAssertion`, `Snapshot` - combined with `+`. |
| **Notes** | Genuinely useful context only. Names the gap for any assumption-derived case. |
| **Review** | Literally `Pending`. Never anything else. |
| **Automation** | Literally `Pending`. Never anything else. |

## 2.1 CSV format - RFC 4180, and why it matters

The procedure is the point of the file, so it must survive the trip into a spreadsheet intact.

- **Quote any field containing a comma, a double quote, or a newline.** In practice: quote Steps,
  Test Data, Preconditions and Expected Result essentially always.
- **Escape an embedded double quote by doubling it**, never with a backslash.
- **Keep real newlines inside the quoted field.** `Steps` is a numbered list on separate lines
  within one cell; Excel, Sheets and LibreOffice all render that as a wrapped multi-line cell.
  Flattening the procedure onto one line with `|` separators produces a cell nobody can read, and
  the procedure is the deliverable.
- **CRLF line endings between records, UTF-8 with a BOM.** The BOM is what makes Excel open
  accented Latin and CJK test data correctly instead of as mojibake - and the suite deliberately
  contains Unicode test data (Stage 3, row B9).
- **Never let a value be coerced.** An ID like `TC-CHK-002` is safe, but a bare `1.10` becomes a
  date in Excel. Where a value would be coerced, keep it quoted and state the intended type in the
  same cell - `1.10 (string)`.

A correctly quoted multi-line row looks like this - note the numbered steps living on their own
lines inside one quoted cell:

```csv
TC-CHK-002,Checkout,"Reject a promo code past its expiry date","Verify that an expired promo code is rejected and leaves the total unchanged.","A cart containing one item priced 100.00 exists for an authenticated customer.","promoCode = WINTER5
expiresAt = 2025-01-31T23:59:59Z (past)","1. Submit the cart to POST /api/checkout.
2. Supply the promo code WINTER5.","The request is rejected with HTTP 422 and error code PROMO_EXPIRED; the payable total is unchanged at 100.00 and no order row is created.",P2,"Atomic, Negative-Temporal, BusinessRule",API,POST /api/checkout,HTTPStatus + JSONBody,"Expiry is compared against server time, not client time.",Pending,Pending
```

**Cases are ordered by module, then by ID**, so the file reads in the same grouped order the design
stage produced and a filtered view stays coherent.

# 3. TestReport_{{SCOPE}}.md - everything else

The CSV answers "what do I run". This answers everything a reviewer, a lead or an automation
engineer needs, and it is the only other file that exists. Write it in this order.

| # | Section | Carries what used to live in |
|---|---|---|
| 1 | **Summary** - scope, repo, commit, generation date, total cases, counts by module / priority / tier / layer / test type | the Summary sheet |
| 2 | **How to use these two files** - one short paragraph: the CSV is the executable suite, this is the evidence and the argument | - |
| 3 | **Coverage - the two denominators** - surfaces covered and **flows covered**, side by side, each with its numerator, denominator and percentage | `CoverageReport.md` |
| 4 | **Coverage status table** - per item: ID, type, status, case IDs, reason, `path:line` | the coverage table |
| 5 | **Evaluation grid** - surface x test type, and flow x journey type, every cell either a case ID or `Not Applicable - reason` | `CoverageReport.md` |
| 6 | **Execution closure and boundaries** - seed vs reached, depth walked, per boundary modes covered / possible, impacted callers, unresolved edges | `DependencyClosure.md` |
| 7 | **Unreachable-Black-Box items** - the rules no surface reaches, with `path:line` and what would have to exist to test them | `CoverageReport.md` |
| 8 | **Traceability matrix** - case to module / use case / rule / surface / `path:line` / risk / confidence | `TraceabilityMatrix.md` |
| 9 | **Test data** - one row per field per dataset: dataset ID, case ID, purpose, field, value, value kind, evidence | `TestData_*.md` |
| 10 | **Execution profile** - case ID, fixtures, teardown, isolation, parallel group, deterministic, est. runtime, automation notes | `ExecutionProfile_*.md` |
| 11 | **Parallel plan** - the isolation groups, their mode, shared resource and case IDs, plus max useful workers | the Parallel Plan sheet |
| 12 | **Specification extract** - surfaces, use cases, business rules and data contracts, each row with `path:line` and confidence | Stages 1-2 |
| 13 | **Gaps and assumptions** - every open question, the assumption taken, and which cases rest on it | `Gaps.md` |
| 14 | **Warnings** - the full list from section 5; `None - every case passed every check.` when clean | the console + Summary sheet |

Sections 4, 8, 9, 10 and 12 are tables, and a table is preferred to prose everywhere it fits - this
report is a thing looked things up in, not read front to back.

**A section is never omitted for being empty.** Write the heading and one line saying it is empty
and why. A missing section reads as an oversight; "No unresolved edges - every import resolved" is
a finding.

## 3.1 Traceability is what makes the pair trustworthy

Every case ID in the CSV appears in the report's traceability table with a `path:line`, and every
case ID in that table exists in the CSV. The two files are joined on Test Case ID, and that join is
the whole reason the report is worth keeping. A case in one file and not the other is a warning
(section 5) and means the pair was assembled inconsistently.

## 3.2 The parallel plan

Derived from each case's isolation level, unchanged from earlier versions:

| Isolation | Group | Mode |
|---|---|---|
| `read-only` | `read-only` | parallel |
| `shared-fixture:<name>` | that fixture | parallel within group |
| `mutates-record:<entity>` | that entity | parallel within group |
| `exclusive:<resource>` | that resource | serial on the resource |
| `global-state` | `global-state` | runs alone |

**An absent or unrecognised isolation value is scheduled `exclusive`, and warned about.** That is
the safe direction: guessing "probably parallel-safe" from a blank buys a fast suite that fails
intermittently, and an intermittent failure costs more than the serial run it avoided.

# 4. Nothing is lost - where each old artifact went

Deleting the intermediate files must not delete their content. Before finishing, confirm every one
of these has a home in the report:

| Old file | Now |
|---|---|
| `SurfaceInventory.md` | section 12 |
| `UseCaseCatalog.md`, `BusinessRules.md`, `DataContracts.md` | section 12 |
| `Gaps.md` | section 13 |
| `DependencyClosure.md` | section 6 |
| `TestData_*.md` | section 9 |
| `ExecutionProfile_*.md` | section 10 |
| `TraceabilityMatrix.md` | section 8 |
| `CoverageReport.md` | sections 3, 4, 5 and 7 |
| the workbook's Summary sheet | sections 1 and 14 |
| the workbook's Parallel Plan sheet | section 11 |
| `testsuite_*.json` | sections 10 and 11 - the CSV plus those sections carry what a runner needs |
| `codemap.lock.json` | Dropped. Drift detection needed a committed baseline file, and there is no longer one. Section 6 records the commit the suite was derived from, which is what a re-run compares against. |

# 5. The checks - run every one before writing

The mechanical exporter that used to enforce these is gone, so **you** enforce them. Check every
case against every row, and put every failure in the report's Warnings section naming the case and
the field. Do not silently fix a case to clear a warning; do not omit the warning.

| # | Check | Why it is not cosmetic |
|---|---|---|
| 1 | Every case has a non-empty **Expected Result** | A case with no expected result is unexecutable, and shipping it silently is how it reaches a runner |
| 2 | Every case's **Layer** is `API`, `UI`, `E2E` or `Contract` | A `Unit` or `Component` case asks for a harness the tester does not have. They skip it - and a skipped case still counts as coverage, so the rule is reported tested when nobody ran it. The fix is to drive the rule through a surface that reaches it, or record it `Unreachable-Black-Box`, never to relabel it |
| 3 | Every case has a non-empty **Module** | An unattributed case is missing from every per-module total while still inflating the overall one |
| 4 | Every case has a **traceability row with a `path:line`** | A case whose expected result traces to nothing is asserting an opinion |
| 5 | Every case ID in the CSV is in the report, and vice versa | The two files join on this; a mismatch means the pair disagrees |
| 6 | Every case has exactly one granularity tier tag | Tier drives the counts in section 1 |
| 7 | Every case has a recognised **Isolation** value | An unrecognised value is scheduled `exclusive` and warned - never assumed parallel-safe |
| 8 | **Review** and **Automation** are literally `Pending` on every row | A suite that advances its own review status has reviewed its own work |
| 9 | Every value is **concrete** - no "a valid X", no "an invalid Y" | An automation runner cannot resolve a description |
| 10 | Every evaluation-grid cell is a case ID or `Not Applicable - reason` | A blank cell is an unfalsifiable completeness claim |
| 11 | Every CSV field needing quotes **is** quoted, and embedded quotes are doubled | One unquoted comma shifts every later column on that row and corrupts the file silently |
| 12 | No intermediate file was left on disk | Section 1 |

Report the counts plainly when you finish: cases written, warnings raised, and the two file paths.
**If any check failed, say so in the response as well as in the report** - a warning that exists
only in a file is a warning the person who ran the pipeline never sees.

# 6. Anti-patterns

| Anti-pattern | Why it is wrong |
|---|---|
| Writing the old intermediate Markdown "as well, just in case" | The whole change is that there are two files. A dozen files that must agree is the problem this replaced. |
| Dropping a section because its source document no longer exists | The document is gone; the content is not. Section 4 lists where each one went. |
| Flattening Steps onto one line to avoid quoting | The procedure is the deliverable. A wrapped multi-line cell is correct and every spreadsheet renders it. |
| Omitting the BOM | Excel renders the Unicode test data the suite deliberately contains as mojibake. |
| Silently fixing a case to avoid a warning | The warning is the finding. Fixing the label without fixing the case - relabelling `Unit` as `API` - leaves steps the tester still cannot run. |
| Writing `Review: Approved` | Self-approval. Only a human moves that column. |
| Emitting the CSV without the report | The CSV alone has no evidence, no coverage denominator and no gaps - it is a list of assertions with nothing behind them. |
| Leaving a scratch file behind | A run that leaves a third file did not do what this stage exists to do. |
