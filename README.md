# test-cases-generator-from-codebases

Claude Code skills that derive a **complete, traceable, execution-ready test suite from a codebase
alone** - and hand you exactly two files: one CSV of test cases with full procedures, and one
Markdown report holding everything behind them.

No running application. No API calls. No browser. No network. The source tree is the entire evidence
base.

```
source file:line  ->  Surface  ->  Use Case / Business Rule  ->  Test Case  ->  CSV row
```

Every link in that chain is recorded. A test case whose chain is broken at any point is a
fabrication, however plausible it reads - and the report says so rather than shipping it quietly.

## Why this exists

The usual way to write tests for an unfamiliar system is to run it and poke at it. That needs a
deployed environment, credentials, seeded data, and someone who already knows what the system is
supposed to do. Often none of those exist yet - the service is half-built, the environment is
someone else's ticket, and the spec is a Slack thread.

The code, however, is right there. It states its own routes, validation intervals, role checks,
error codes and state machines. This package reads them, writes them down with citations, and turns
them into a suite you can hand to a manual tester, an automation project, or an agentic runner -
while the developers keep working.

## What you get

**One run produces two files covering the whole scope.** Modules are a column in them, not separate
files: a tester filters one file, and every total is a real total.

| File | For |
|---|---|
| `TestCases_{Scope}.csv` | The deliverable. **Every case in the scope, one row each**, with the full numbered procedure, preconditions, concrete test data, expected result, priority, tags, layer, entry point and oracle. RFC 4180, opens clean in Excel, Sheets and LibreOffice. |
| `TestReport_{Scope}.md` | Everything behind the cases, in fourteen fixed sections: coverage against **two denominators**, the surface x test-type and flow x journey-type evaluation grids, the execution closure and its boundaries, unreachable-black-box findings, the traceability matrix with `path:line`, the test data, the execution profile, the parallel plan, the specification extract, every gap and the assumption taken, and the warning list. |

Stages 1-3 produce a great deal more - surface inventory, use case catalogue, business rules, data
contracts, dependency closure - and **none of it is written to disk**. It is carried in context and
rendered into those two files; every former document has a destination section in the report. What
is dropped is the file, not the fact.

**Why two files.** A reviewer answering one question used to open eight documents, and the same fact
existed in three renderings - Markdown, workbook and JSON - that could quietly disagree. Two files
cannot disagree about anything except the case IDs that join them, and that join is checked before
they are written.

**Zero runtime dependencies.** `npm install` is not required.

## Install

```bash
git clone https://github.com/AtefSaber-sheen/test-cases-generator-from-codebases.git
cd test-cases-generator-from-codebases
npm test
```

Then make the skills visible to Claude Code: work from this directory, or copy `.claude/skills/*`
into the project you want to test (or into `~/.claude/skills/` for every project).

## Run it

```bash
# Stage 1 - mechanical sweep first, then the skill confirms every candidate
node test-cases-generator-demo-tools/recon_scan/cli.js --repo ../my-app                    # static inventory
node test-cases-generator-demo-tools/depgraph/cli.js   --repo ../my-app --scope src/checkout  # dependency closure
```

Both print to stdout; the skills read that output and nothing is saved. Then, in Claude Code:

```
Use the codebase-recon skill on ../my-app, scope src/checkout.
Then behavior-spec, then test-design-from-code, then suite-export to ./out.
```

## Running it on part of a system

This is the case the tool is built around, because it is the normal one: you are handed a service, a
module or a pull request - not a whole repository - and it calls a dozen things you did not write.

**A narrower scope is a seed, not a filter.** Point it at `src/checkout` and the controller calls a
promotion service, which calls a repository, which calls an ORM. It reads a feature flag. It charges
a card. Treat those as black boxes and you have covered one layer of a five-layer execution path:
the suite goes green, coverage says 100%, and the regression ships in the layer below.

So the closure is walked first:

| What is found | How it is treated |
|---|---|
| **In-repo callees**, transitively, at any depth | **In scope.** Readable, so not a black box - it is more scope. A rule enforced three hops down is enforced on the same request. |
| **Unreadable dependencies** - an SDK, a driver, a remote API | An `EXT` boundary surface, addressed at its **call sites**. The package is not testable; the caller is. |
| **Callers from outside the closure** | Blast radius. They execute the code under test without being named by the scope, so they get regression cases. |
| **Edges that cannot be resolved** - a DI token, a computed import | A gap. The path beyond is *unknown*, never *absent*, and the run exits 2 rather than claiming completeness. |

**What a boundary turns into.** Rather than a stub and a shrug, each unreadable dependency is
classified by **role** and carries the failure modes that role can produce - 13 roles, 59 named
modes. A payment gateway declines, replays an idempotency key and times out; a relational driver
deadlocks and violates constraints; an HTTP client returns 5xx and malformed bodies.

That is the difference between a case a runner can execute -

> Gateway returns `card_declined` at `payment.service.ts:34` -> HTTP 422 `PAYMENT_FAILED`, no order row

- and one nobody can:

> Simulate an error from the payment provider

Each boundary also states the isolation a test driving it can honestly claim, so the parallel plan
stays safe: a shared payment sandbox cannot run concurrently with itself.

## Every case is one a tester can actually run

The suite is written for a **software tester with a deployed system, an HTTP client and a browser** -
not for a developer with the repository checked out.

So the allowed layers are `API`, `UI`, `E2E` and `Contract`, and nothing else. A `Unit` or
`Component` case would ask the tester to wire up a harness and call a function directly; they will
skip it, **and a skipped case still counts as coverage in every total** - which is how a rule comes
to be reported as tested when nobody ever exercised it. Stage 4 rejects those layers.

A rule enforced deep in the call graph is therefore *pulled up*, never tested down:

| The rule | The case |
|---|---|
| Rounding decided in `PromoService.apply` at `promo.service.ts:17` | Driven through `POST /api/checkout`, asserting `discount` in the response. The evidence still cites the deep line |
| Enforced below two endpoints that handle it differently | One case per endpoint - the difference *is* the behaviour |
| Reached by **no** endpoint, screen, job, message or command | Recorded `Unreachable-Black-Box` with its `path:line`. That is dead code or a missing surface - a finding worth more than a test QA cannot run |

**Flows, not just surfaces.** Covering every endpoint one at a time never exercises the system the
way it is used. Alongside the surface x test-type grid, the suite enumerates **flows** - multi-surface
journeys from the use cases, state machines and UI routes - and evaluates ten journey types against
each: happy path, alternates, interruption mid-flow, resume, back-and-resubmit, cross-surface
consistency, cross-role handover, failure recovery, full entity lifecycle, and UI/API contract.

Coverage is reported as **two denominators side by side**: surfaces covered and flows covered. A
suite at 100% of surfaces and 20% of flows is not a covered system, and reporting only the first
number hides exactly that.

## The four skills

| Stage | Skill | Answers |
|---|---|---|
| 1 | **`codebase-recon`** | *What is here, and where exactly?* Stack, module partition, and an exhaustive inventory of testable surfaces - API, UI, jobs, messaging, CLI, data, auth, config - each with `path:line` |
| 2 | **`behavior-spec`** | *What does it do?* Use cases, business rules, data contracts, state machines, authorization boundaries, error behaviour, config dependence. Every claim cites the line that proves it, with a Confirmed / Inferred / Assumed confidence |
| 3 | **`test-design-from-code`** | *How is it tested?* The full suite in one scope-wide set. Every test type evaluated against every surface, every journey type against every flow, boundary values derived mechanically from the code's own constraints, plus execution profile and traceability. Black-box layers only |
| 4 | **`suite-export`** | *Where is the deliverable?* The two files - the CSV of cases and the report - after twelve checks over every case |

Stages 1-3 hand their findings forward in context; Stage 4 is the only one that writes.

See [`test-cases-generator-demo-docs/WORKFLOW.md`](test-cases-generator-demo-docs/WORKFLOW.md) for
the operator guide and the gate checklist at each handoff.

## Running alongside active development

A suite derived from source is only as true as the source it came from, and development does not stop
while the suite is reviewed. A validator that gained a rule last Tuesday silently invalidates every
boundary case written against the old one - quietly, because the cases still read fine.

The report records the commit the suite was derived from, and every case cites a `path:line` in the
traceability table. So:

```bash
git -C ../my-app diff --name-only <recorded-commit>..HEAD
```

Every case citing a changed file is a case to re-examine. A changed file does not prove a case is
wrong - the change may be a comment - so this names what to re-check and leaves the judgment where it
belongs. Re-run Stages 2-3 scoped to those files only; that keeps the already-reviewed cases
reviewed.

## Running the suite in parallel

Each case declares an **isolation level**, and the report turns those into a scheduling plan:
`read-only` fully parallel · `shared-fixture:<name>` parallel within its group ·
`mutates-record:<entity>` parallel within its group · `exclusive:<resource>` serialized on that
resource · `global-state` runs alone.

An absent or unrecognised value is scheduled `exclusive` - the safe direction, and it is flagged in
the warnings. Guessing "probably parallel-safe" is how a suite starts failing intermittently in CI,
and an intermittent failure costs more than the serial run it avoided.

## Handing the suite to an automation or agentic runner

The CSV says what to run; the report's Execution profile and Parallel plan sections say how. A runner
should execute cases with `Review == Approved` and automate only when `Automation == Approved` too,
**recording every non-approved case as excluded with its reason** so a run cannot report "3 of 3
passed" while the rest went unexamined; schedule from the parallel plan rather than its own guess;
provision the named fixtures and honour the teardown; assert per the oracle (a case whose oracle
names `HTTPStatus + DBState` is not passed by a green status alone); bind the datasets and report per
dataset; report against the stable Test Case ID; and respect `Deterministic: No` by not retrying
until green.

Parse the CSV with a real RFC 4180 parser: the `Steps` cell deliberately holds a multi-line
procedure, and splitting on newlines corrupts it silently. Full contract in
[`test-cases-generator-demo-docs/AGENTIC_HANDOFF.md`](test-cases-generator-demo-docs/AGENTIC_HANDOFF.md).

## The rule that holds it together

```
Stages 1-3   findings held in context      (nothing written)
Stage 4      ONE CSV + ONE Markdown report (generated)
```

**The two files are generated.** Re-running overwrites them, so an edit made in the CSV is discarded
on the next run. Fix the design and re-run rather than patching the output.

The exception is `Review` and `Automation`, which record human decisions taken *after* generation.
They ship as `Pending` on every row, and no skill ever writes any other value - a suite that advances
its own review status has reviewed its own work. Because a re-run regenerates the CSV, merge those
two columns back by Test Case ID before regenerating, or re-review. The IDs are stable precisely so
that merge is possible.

## Layout

```
.claude/skills/                                    the four skills, each under 100 lines
test-cases-generator-demo-tools/recon_scan/        static inventory: stack, surfaces, existing tests, what was NOT searched
test-cases-generator-demo-tools/depgraph/          dependency closure: what a scope executes, its boundaries, its blast radius
test-cases-generator-demo-docs/WORKFLOW.md         operator guide: what to run, what to read, what to check at each gate
test-cases-generator-demo-docs/AGENTIC_HANDOFF.md  how a runner consumes the CSV and the report
examples/app/                                      a small worked application to run the pipeline against
```

## Limits worth knowing

- **Static analysis cannot see runtime.** A route behind a disabled flag, a job with an empty
  schedule, a controller nobody imports - all look live. The skills record the doubt in the report's
  Gaps section rather than resolving it silently.
- **Confidence is reported, not assumed.** A spec that is 60% `Assumed` is a research report, and the
  report says so.
- **The recon sweep produces candidates, not findings.** Every one is confirmed by opening the file.
  Where a detector hits its cap, the report says how many hits were dropped - a truncated list that
  reads as complete is worse than no list.
- **The dependency graph is a floor, not a ceiling.** Edges come from import syntax and call-site
  text, not a type checker. An edge created by an injection token, reflection, a service locator or a
  computed import cannot be seen that way - so every such place that *is* detectable is listed as an
  unresolved edge, and the run exits 2 rather than claiming the closure is complete.
- **A boundary failure mode is an input, not a prediction.** The mode list says what a payment gateway
  or database driver can do; what your caller does about each is read from your code, and where it
  does nothing that absence is recorded as the finding.
- **The checks are enforced by the skill, not by a parser.** Stage 4 runs twelve checks over every
  case and reports each failure in the report's Warnings section. That is an instruction followed by a
  model rather than a program - read the Warnings section rather than assuming it is empty.

MIT licensed.
