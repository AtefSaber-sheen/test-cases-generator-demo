# Operator guide - driving the four stages

The human's view: what to run, what to read, what to check before each handoff. The skills hold the
rules; this holds the sequence and the gates.

## Output layout

**One run, one scope, two files.**

```
<out>/
├── TestCases_<Scope>.csv     every case in the scope, full procedures  (Stage 4)
└── TestReport_<Scope>.md     coverage, gaps, assumptions, traceability,
                              test data, execution profile, warnings    (Stage 4)
```

Stages 1-3 produce a great deal - surface inventory, use cases, business rules, data contracts,
dependency closure, gaps, test data, execution profile, traceability, coverage - and **none of it
reaches disk**. It is carried in context and rendered into those two files by Stage 4, whose "where
each former document went" list maps every one to a report section. What is dropped is the file, not
the fact.

**Modules are a column, not a file.** The Stage 1 partition rides as a `Module` value on every
surface row, then every traceability row, and ends as a column in the single CSV. Splitting across
files gives six partial totals and no scope-wide number - the only number that answers "are we
covered?". Split into two *runs* when a scope is genuinely too large to review, never into two files
for one run.

## Stage 1 - recon

```bash
node test-cases-generator-demo-tools/recon_scan/cli.js --repo ../my-app
node test-cases-generator-demo-tools/depgraph/cli.js   --repo ../my-app --scope src/checkout
```

Both print to stdout; read the output rather than saving it. Then invoke `codebase-recon`: the scan
gives candidates, the skill confirms each by opening the file.

**Read first:** the scan's **`skipped`** block (anything there was not searched, and every later
conclusion inherits that hole) and the **exit code** - `2` means a detector capped or a path was
unreadable, so the candidate list is incomplete and Gaps must say so.

**Gate to Stage 2:**

- [ ] Every surface row has an `SF-` ID, a `Module`, a Confidence, and `path:line`
- [ ] ONE surface inventory for the whole scope, not one per module
- [ ] No blank `Auth` cell - `None (unauthenticated)` and `Unknown - GAP-nnn` are the two ways to
      say "no auth"; blank is not one of them
- [ ] The codebase map names the validation library, the authorization mechanism and the layer where
      behaviour is decided - Stage 2 cannot find rules without these three
- [ ] The denominator is reported: surfaces confirmed, candidates rejected, files searched of files
      present, and what was not searched
- [ ] The registration roots read exhaustively are listed by name
- [ ] Below `full-repo`: every **reached** file is inventoried, not just the seed; every `EXT`
      boundary has a row; impacted callers are named; unresolved edges each have a `GAP-`

**Commonest Stage 1 defect:** a controller recorded as one surface. Its five routes have five
different inputs, outputs and authorization rules - one row hides four surfaces, and coverage still
reads 100%.

## Stage 2 - behaviour spec

Invoke `behavior-spec`. It reads outward from each surface: validator, guards, handler branches,
throws, callees to the bottom of the closure, persistence, config, side effects.

**Read first:** the **confidence distribution** (a spec 60% `Assumed` is a research report, and the
suite inherits that) · **constraint conflicts** (a DTO `max 120` over a `varchar(100)` column - the
effective limit is 100 and the gap is where a defect lives) · fields recorded **`None enforced in
code`**, often the most interesting finding in the run.

**Gate to Stage 3:**

- [ ] Every row has `path:line` and a Confidence; every `Assumed` row has a matching `GAP-`
- [ ] No rule statement contains "correctly", "properly", "as expected", or "handles"
- [ ] Every constraint states inclusivity explicitly (`1 <= n <= 99`, not "max 99")
- [ ] Every business rule has a Failure Mode, or is a `Calculation`
- [ ] Every surface is covered by a use case, or has a gap saying why not
- [ ] Every rule has an `Observable Via` naming a surface a tester can address, or is marked
      `Unreachable - no surface reaches this rule`
- [ ] Multi-surface use cases are identified as flows - Stage 3 cannot enumerate journeys the
      catalogue never recorded
- [ ] Compound rules are split; enums and transition sets are enumerated
- [ ] Every `EXT` boundary has one rule per failure mode, unhandled modes included

## Stage 3 - test design

Invoke `test-design-from-code`. It builds a surface x test-type grid plus a flow x journey-type grid,
fills every cell with cases or `Not Applicable - reason`, derives data mechanically from the
constraints, and produces the execution profile and traceability.

**Read first:** the **evaluation grid** (the completeness argument - a blank cell means nobody
decided) · **flow coverage**, the second denominator (100% of surfaces with 20% of flows is not a
covered system, and the surface percentage alone hides that) · the **`Layer`** column (every value
must be `API`, `UI`, `E2E` or `Contract`; a `Unit` case is one the tester skips, and a skipped case
still counts as coverage) · **`Unreachable-Black-Box`** items (dead code or a missing surface, both
findings worth more than a test QA cannot run) · the **`Isolation`** column (if most cases say
`exclusive` or nothing, the suite runs serially and the parallel plan is worthless) ·
**assumption-derived cases**, the ones most likely to fail against correct code.

**Gate:** every case has the twelve fields, a valid layer, a module, a traceability row with
`path:line`, a recognised isolation value, and a provenance row - a `Source` matching its traceability
evidence and a `Reason for Extraction` naming the rule, boundary, mode, contract or journey behind it.
The run provenance (Claude model, effort level, verbatim user prompt) is recorded once, as observed.
Stage 4 checks all of this and reports what fails.

## Stage 4 - write the two files

Invoke `suite-export`. It runs its seventeen checks, then writes `TestCases_<Scope>.csv` (RFC 4180,
quoted multi-line cells) and `TestReport_<Scope>.md` (fourteen fixed sections).

**Read the Warnings section first** - the last section, where every failed check lands naming the
case and the field. A clean run says `None - every case passed every check.`

Each CSV row also carries its own provenance: `Source` and `Reason for Extraction` say where that case
came from, and `Claude Model`, `Effort Level` and `User Prompt` say which run wrote it - the same three
on every row, and repeated in the report Summary so the pair is self-describing. That is what lets a
row survive being filtered out of the file it was born in and still be traced back.

**The review loop.** `Review` and `Automation` ship as `Pending` on every row - no skill writes any
other value, because a suite that advances its own review status has reviewed its own work. A
reviewer filters by module or `Priority = P1`, reads the case, and sets those two columns.

Reviewer decisions live in the reviewer's copy. **Re-running regenerates the CSV and does not
preserve them**, so either re-review or merge those two columns back by Test Case ID before
regenerating. The IDs are stable precisely so that merge is possible.

## Keeping it true while development continues

There is no lock file or automated drift check - both needed a committed baseline artifact the run no
longer produces. What replaces it is the evidence: every case cites a `path:line` in the traceability
table, and the report records the commit the suite was derived from.

```bash
git -C ../my-app diff --name-only <recorded-commit>..HEAD
```

Cross-reference those paths against the traceability table's `Source Evidence`; every case citing a
changed file is a case to re-examine. A changed file does not prove a case is wrong - the change may
be a comment - so this names what to re-check and leaves the judgment to a human. Re-run Stages 2-3
**scoped to those files only**: far cheaper than regenerating the scope, and it keeps the
already-reviewed cases reviewed.

## Re-running a stage

| What is wrong | Re-run |
|---|---|
| A surface was missed or mis-scoped | Stage 1 for that area, then Stages 2-3 for the affected surfaces |
| A rule is wrong or a constraint was misread | Stages 2-3 for the surfaces citing it |
| A case reads badly, but the rule is right | Stage 3 for that case, then Stage 4 |
| Reviewer decisions look lost | The CSV was regenerated over them. Recover from the reviewer's copy or from git, merging on Test Case ID |
| The CSV has stale content | Re-run Stage 4. The CSV is generated, never the source of truth |

**IDs are stable across re-runs.** Retire an ID when its subject disappears; never reuse it. A
re-run that renumbers silently invalidates every traceability row written against the old numbering,
and every result already recorded against those IDs.

## CI wiring

The pipeline is agent-driven, so there is no exporter binary for CI to call. What CI can check is
the committed pair:

```yaml
- run: |
    test -f TestCases_Checkout.csv || { echo "no suite"; exit 1; }
    grep -q "None - every case passed every check." TestReport_Checkout.md \
      || { echo "suite has warnings - read the report's Warnings section"; exit 1; }
```

Never suppress that check: the alternative is finding out at execution time that a case has no
Expected Result.
