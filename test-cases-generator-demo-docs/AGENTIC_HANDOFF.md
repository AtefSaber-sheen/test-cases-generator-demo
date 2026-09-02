# Consuming the suite

The contract between this package and whatever runs the tests - an automation project, an agentic
runner, or a script somebody writes in an afternoon.

A run produces two files:

| File | For the runner |
|---|---|
| `TestCases_<Scope>.csv` | The cases. One row each, with the full procedure, the layer, the entry point and the oracle. |
| `TestReport_<Scope>.md` | The execution profile (fixtures, teardown, isolation, determinism), the parallel plan, the test data, and the traceability that joins back to the code. |

They join on **Test Case ID**, which is stable across re-runs. Read the CSV for what to run and the
report's Execution profile and Parallel plan sections for how to run it.

## Parsing the CSV

It is RFC 4180 with UTF-8 and a BOM, and it **deliberately contains multi-line quoted fields** - the
`Steps` cell holds a numbered procedure on separate lines, because a flattened procedure is one no
tester can read.

So use a real CSV parser. Splitting on commas, or reading the file line by line, will corrupt every
case with a multi-line step list, and will do it silently:

```js
// Node, zero dependencies beyond a parser that honours RFC 4180 quoting.
const { parse } = require('csv-parse/sync');
const rows = parse(fs.readFileSync('TestCases_Checkout.csv'), {
  columns: true,
  bom: true,             // strip the BOM Excel needs
  relax_column_count: false,
});
```

Steps are recovered by splitting that one cell on newlines:

```js
const steps = row.Steps.split(/\r?\n/).filter(Boolean);
```

---

## The seven rules a correct runner follows

### 1. Gate on lifecycle, and report what you excluded

```js
const eligible    = rows.filter(r => r.Review === 'Approved');
const automatable = eligible.filter(r => r.Automation === 'Approved');
const excluded    = rows.filter(r => r.Review !== 'Approved');
```

An excluded case is **recorded with its reason and counted in every total**, never silently dropped.
A run that reports "3 of 3 passed" while 81 cases went unexamined is worse than no run: it
manufactures confidence nobody earned.

`Automation === 'Rejected'` means *run it by hand* - a reason to schedule a manual pass, not a
reason to skip it.

An `Automation === 'Approved'` with `Review !== 'Approved'` pair is a contradiction between two human
decisions. Report it; never reconcile it yourself.

A freshly generated suite has `Pending` in both columns on every row, by design - no skill may write
any other value. A runner pointed at an unreviewed suite should say so and stop, not execute it.

### 2. Schedule from the report's parallel plan, not from your own guess

The Parallel plan section lists each group, its mode, its shared resource and its case IDs:

| Mode | Scheduling |
|---|---|
| `parallel` | any worker, any time |
| `parallel-within-group` | concurrent with other groups; coordinate inside the group |
| `serial` | one at a time on the named resource |
| `serial-global` | runs alone; nothing else concurrent |

Never infer parallel-safety from the case text. A case with no stated isolation is scheduled
`exclusive` by Stage 4 and flagged in the Warnings section - honour that rather than optimising it
away. Guessing "probably parallel-safe" buys a fast suite that fails intermittently, and an
intermittent failure costs more to diagnose than the serial run it avoided.

`maxUsefulWorkers` is capped by the plan, not by the machine: more workers than schedulable groups
buys nothing.

### 3. Provision fixtures, honour teardown

Both are per case in the report's Execution profile section. Fixtures are **named**
(`seed:promo-winter5-expired`) precisely so a runner can share and reuse them across the cases that
declare the same one. Teardown of `none` means none is required, not that none was considered.

### 4. Assert per the oracle

The `Oracle` column names what constitutes a pass - `HTTPStatus`, `JSONBody`, `SchemaMatch`,
`DBState`, `EventEmitted`, `LogEntry`, `UIAssertion`, `Snapshot`, combined with `+`. Assert what it
names. A case whose oracle says `HTTPStatus + DBState` is not passed by a green status alone; the
stored state is half the assertion, and it is the half that catches the interesting defects.

### 5. Bind the test data

The report's Test data section carries one row per field per dataset, keyed by Test Case ID. Several
datasets against one case means **one behaviour parameterized** - run the case once per dataset and
report per dataset, rather than collapsing them into a single result.

Every value is concrete by construction. A runner should never encounter "a valid promo code"; if it
does, that is a Stage 3 defect and worth reporting back rather than improvising a value.

### 6. Report against the Test Case ID

The ID is the join key back to the CSV, the traceability table and the coverage sections. Report
results against it and a reader can go from a red result to the `path:line` that the case was
derived from in one step.

### 7. Respect non-determinism

The Execution profile marks a case `Deterministic: No` with a reason in Automation Notes - real
time, an external sandbox, randomness. **Do not retry it until it goes green.** A retry loop over a
non-deterministic case converts a real signal into noise, and the reason column already says why the
case cannot be trusted to repeat.

---

## What the runner should NOT do

| Anti-pattern | Why |
|---|---|
| Parsing the CSV by splitting on commas or newlines | Multi-line quoted cells are deliberate and load-bearing. This corrupts cases silently. |
| Executing a suite whose rows are all `Pending` | Nobody has reviewed it. Say so and stop. |
| Inferring parallelism from case text | The isolation level is stated. Guessing produces intermittent CI failures. |
| Retrying a `Deterministic: No` case until green | Converts the one honest signal the suite gave you into noise. |
| Dropping excluded cases from the totals | Manufactures a pass rate nobody earned. |
| Editing the CSV and expecting it to survive | It is generated. Re-running Stage 4 overwrites it. |
