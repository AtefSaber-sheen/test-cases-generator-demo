# Operator guide - driving the four stages

This is the human's view: what to run, what to read, and what to check before letting each stage
hand off to the next. The skills themselves hold the rules; this holds the sequence.

## Output layout

**One run, one scope, two files.**

```
<out>/
├── TestCases_<Scope>.csv     every case in the scope, full procedures  (Stage 4)
└── TestReport_<Scope>.md     coverage, gaps, assumptions, traceability,
                              test data, execution profile, warnings    (Stage 4)
```

That is the complete output. Stages 1-3 produce a great deal - the surface inventory, the use case
catalogue, the business rules, the data contracts, the dependency closure, the gaps, the test data,
the execution profile, the traceability matrix, the coverage report - and **none of it is written to
disk**. It is carried in context and rendered into those two files by Stage 4.

Nothing is lost in the process: `suite-export` section 4 maps every former document to the report
section that now carries it. What is dropped is the file, not the fact.

**Why two files rather than a folder.** A reviewer answering one question used to open eight
documents, and the same fact existed in three renderings that could disagree - the Markdown, the
workbook and the JSON. Two files cannot disagree with each other about anything except the case
IDs that join them, and Stage 4 checks that join explicitly.

**Modules are a column, not a file.** The partition drawn at Stage 1 rides as a `Module` value on
every surface row, then on every traceability row, and ends up as a column in the single CSV. The
tester filters that column. Splitting the scope across files would give six partial totals and no
scope-wide number - the only number that answers "are we covered?".

Split into two *runs*, each with its own scope and its own pair of files, when a scope is genuinely
too large to review. Never into two files for one run.

---

## Stage 1 - recon

```bash
node tools/recon_scan/cli.js --repo ../my-app
node tools/depgraph/cli.js   --repo ../my-app --scope src/checkout
```

Both tools print to stdout; read their output rather than saving it. Then invoke `codebase-recon`.
The scan gives candidates; the skill confirms each by opening the file.

**Read before continuing:**

- The scan's **`skipped`** block. Anything there was not searched, and every later conclusion
  inherits that hole.
- Exit code. `2` means a detector hit its cap or a path was unreadable - the candidate list is
  incomplete and the Gaps section must say so.

**Gate - do not start Stage 2 until:**

- [ ] Every surface row has an `SF-` ID, a `Module`, a Confidence, and `path:line`
- [ ] There is ONE surface inventory for the whole scope, not one per module
- [ ] No `Auth` cell is blank (`None (unauthenticated)` and `Unknown - GAP-nnn` are the two ways to
      say "no auth"; blank is not one of them)
- [ ] The codebase map names the validation library, the authorization mechanism, and the layer
      where behaviour is decided - Stage 2 cannot find rules without these three
- [ ] The denominator is reported: surfaces confirmed, candidates rejected, files searched of files
      present, and what was not searched
- [ ] The registration roots that were read exhaustively are listed by name

**The commonest Stage 1 defect** is a controller recorded as one surface. Its five routes have five
different inputs, outputs and authorization rules; one row hides four surfaces and the coverage
report will nonetheless read 100%.

---

## Stage 2 - behaviour spec

Invoke `behavior-spec`. It reads outward from each surface: validator -> guards -> handler branches
-> throws -> service -> persistence -> config -> side effects.

**Read before continuing:**

- The **confidence distribution**. A spec that is 60% `Assumed` is a research report, and the suite
  built on it will inherit that.
- **Constraint conflicts.** A DTO saying `max 120` over a `varchar(100)` column is where a defect
  lives; the effective limit is 100.
- Fields recorded as **`None enforced in code`**. That absence is usually the most interesting
  finding in the whole run.

**Gate - do not start Stage 3 until:**

- [ ] Every row has `path:line` and a Confidence
- [ ] Every `Assumed` row has a matching `GAP-`
- [ ] No rule statement contains "correctly", "properly", "as expected", or "handles"
- [ ] Every constraint states inclusivity explicitly (`1 <= n <= 99`, not "max 99")
- [ ] Every business rule has a Failure Mode, or is a `Calculation`
- [ ] Every surface is covered by a use case, or has a gap saying why not
- [ ] Every rule has an `Observable Via` naming a surface a tester can address, or is marked
      `Unreachable - no surface reaches this rule`
- [ ] Multi-surface use cases are identified as flows - Stage 3 cannot enumerate journeys the
      catalogue never recorded
- [ ] Compound rules are split; enums and transition sets are enumerated

---

## Stage 3 - test design

Invoke `test-design-from-code`. It builds a surface x test-type grid, fills every cell with either
cases or `Not Applicable - reason`, derives data mechanically from the constraints, and produces the
execution profile and traceability.

**Read before continuing:**

- The **evaluation grid**. This is the completeness argument. A blank cell means nobody decided.
- **Flow coverage.** The second denominator. 100% of surfaces with 20% of flows is not a covered
  system, and the surface percentage alone hides that.
- The **`Layer`** column. Every value must be `API`, `UI`, `E2E` or `Contract` - the layers a tester
  can drive against a running system. A `Unit` case is one they will skip, and a skipped case still
  counts as coverage.
- **`Unreachable-Black-Box`** items. Rules no surface reaches: dead code, or a missing surface.
  Both are findings worth more than a test QA cannot run.
- The **`Isolation`** column. If most cases say `exclusive` or nothing, the suite will run serially
  and the parallel plan is worthless.
- **Assumption-derived cases.** These are the ones most likely to fail against correct code.

**Gate:** every case has the twelve fields, a valid layer, a module, a traceability row with
`path:line`, and a recognised isolation value. Stage 4 checks all of this and reports what fails.

---

## Stage 4 - write the two files

Invoke `suite-export`. It runs the twelve checks in its section 5, then writes:

- `TestCases_<Scope>.csv` - every case, full procedure, RFC 4180 with quoted multi-line cells
- `TestReport_<Scope>.md` - everything else, in fourteen fixed sections

**Read the Warnings section first.** It is the last section of the report and it is where every
failed check lands, naming the case and the field. A clean run says
`None - every case passed every check.`

**The review loop.** `Review` and `Automation` ship as `Pending` on every row - no skill may write
any other value, because a suite that advances its own review status has reviewed its own work. A
reviewer filters the CSV by module or by `Priority = P1`, reads the case, and sets those two
columns.

Reviewer decisions live in the reviewer's copy of the CSV. **Re-running the pipeline regenerates the
CSV and does not preserve them**, so either re-review, or merge the two columns back by Test Case ID
before regenerating. The IDs are stable precisely so that merge is possible.

---

## Keeping it true while development continues

A suite derived from source is only as true as the source it came from, and development does not
stop while the suite is reviewed. There is no longer a lock file or an automated drift check - both
needed a committed baseline artifact, and the run no longer produces one.

What replaces it is the evidence itself. Every case cites a `path:line` in the report's traceability
table, and the report records the commit the suite was derived from. To find what a week of
development invalidated:

```bash
git -C ../my-app diff --name-only <recorded-commit>..HEAD
```

Cross-reference those paths against the traceability table's `Source Evidence` column; every case
citing a changed file is a case to re-examine. A changed file does not prove a case is wrong - the
change may be a comment - so this names what to re-check and leaves the judgment to a human.

Re-run Stages 2-3 **scoped to those files only**. That is far cheaper than regenerating the scope,
and it keeps the already-reviewed cases reviewed.

---

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

---

## CI wiring

The pipeline is agent-driven, so there is no exporter binary for CI to call. What CI can check is
the committed pair:

```yaml
- run: |
    test -f TestCases_Checkout.csv || { echo "no suite"; exit 1; }
    grep -q "None - every case passed every check." TestReport_Checkout.md \
      || { echo "suite has warnings - read the report's Warnings section"; exit 1; }
```

Never suppress that check. It exists because the alternative is finding out at execution time that a
case has no Expected Result.
