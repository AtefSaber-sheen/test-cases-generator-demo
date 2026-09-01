---
name: codebase-recon
description: Stage 1 of test generation from a codebase alone. Maps an unfamiliar repository — backend, frontend, or both — into a stack profile, a module partition, and an exhaustive inventory of TESTABLE SURFACES, every row evidenced by `path:line`. Runs entirely on source: no running application, no API calls, no browser, no network. Use when starting test design for a repository, when a new service or module must be brought under test, or when an existing surface inventory needs refreshing after significant development.
inputs:
  - name: repository
    type: directory_path
    required: true
    description: Root of the codebase to investigate. Read-only — this skill never modifies the target repository.
  - name: scope
    type: string
    required: false
    description: "What to inventory: `full-repo` (default), a module/path (`apps/api`), or a change scope (`diff:main`, a PR branch, a list of files). A narrower scope is a SEED, not a filter: the dependency closure of those files is inventoried too, so a service the scope calls is covered rather than stubbed."
outputs:
  - name: codebase_map
    type: in_context
    description: Stack, build and run topology, module partition, architectural layering, and where behaviour is decided. HELD IN CONTEXT - not written to disk.
  - name: surface_inventory
    type: in_context
    description: One row per confirmed testable surface, with a stable `SF-` ID and `path:line` evidence. HELD IN CONTEXT. Rendered into the Stage 4 report's Specification extract, and it is the coverage denominator Stage 3 works against.
  - name: gaps
    type: in_context
    description: Everything the source could not settle - with the assumption taken, if any. HELD IN CONTEXT. Rendered into the Stage 4 report's Gaps and assumptions section.
  - name: dependency_closure
    type: in_context
    description: Output of `tools/depgraph` - the files the scope transitively executes, the internal call graph with call-site lines, the unreadable dependencies reached (each an `EXT` surface with its failure modes), the callers impacted by a change, and every edge that could not be resolved. HELD IN CONTEXT. Rendered into the Stage 4 report's Execution closure and boundaries section.
  - name: recon_scan
    type: in_context
    description: Output of `tools/recon_scan` - the candidate list this stage confirmed or rejected. Read from the tool's stdout; kept in context so the report can state what was searched.
dependencies:
  - Node.js >= 18 (for tools/recon_scan and tools/depgraph)
  - Read / Grep / Glob file tools (or their lean-ctx equivalents)
---

> **Pipeline position:** Stage 1 of 4 — `codebase-recon` → `behavior-spec` → `test-design-from-code` → `suite-export`.
> **The chain of custody:** `source file:line → Surface → Use Case / Business Rule → Test Case → CSV row`. Every link is recorded, in that order. A test case whose chain is broken at any link is a fabrication, however plausible it reads.

# 1. Purpose

Turn a repository nobody on the QA side has read into a **complete, evidenced list of the things that can be tested** — and an honest statement of what could not be determined from source.

This is deliberately the narrow half of the work. This stage does not decide what a surface *should* do (Stage 2) and does not write a test case (Stage 3). It answers one question exhaustively: **what is there, and where exactly is it?**

# 2. The constraint that shapes everything

**There is no running application.** No API to call, no UI to click, no logs, no database to inspect, no network. The source tree, its manifests, its configuration files and its version history are the entire evidence base.

Three consequences follow, and they are not negotiable:

| Consequence | What it means in practice |
|---|---|
| **Nothing is observed — everything is read** | A claim about behaviour is a claim about code you have read. "The endpoint returns 404" is only sayable if you have seen the line that returns 404. |
| **Absence of evidence is reportable** | If a route's authorization cannot be determined from source, that goes in **Gaps**. It never becomes "presumably authenticated". |
| **Static reachability is not runtime reachability** | A registered route behind a disabled feature flag, a controller in a module that is never imported, a job whose schedule is empty — all look live. Note the doubt rather than resolving it silently. |

**Never do any of these:** start the application, run its test suite for observation, call an endpoint, open a browser, hit the network, or write to the target repository.

# 3. Inputs and how to resolve them

1. **Repository root.** Confirm it exists and is a source tree, not a build output.
2. **Scope.** Default `full-repo`. Three other shapes are supported:
   - **module** — a path (`apps/api`, `src/billing`).
   - **change** — a diff (`diff:main`, a branch, a file list).
   - **feature** — a named capability. Locate it by searching for its domain vocabulary, then treat the located files as a module scope.

   **A scope narrower than `full-repo` is a SEED, never a filter.** See §3.1 — this is not a
   refinement of the rule, it is the rule.
3. **This stage writes nothing.** Its findings are carried in context to Stages 2-4; only Stage 4 writes, and only two files. Never write inside the target repository.

If scope is ambiguous and the readings differ materially, ask once, then proceed. Do not stall the whole inventory on a question that affects one module.

## 3.1 A sub-scope is a seed, not a boundary

This is the single most consequential rule in this stage, and getting it wrong produces a suite
that passes while the system is broken.

Point this stage at `src/checkout` and the naive reading is: inventory the surfaces defined in that
directory. But the checkout controller calls a promotion service, which calls a repository, which
calls an ORM. It reads a feature flag. It publishes an event. Every one of those is a place the
behaviour under test can go wrong, and every rule enforced on those paths is a rule the part under
test can violate.

Treat them as black boxes and you have covered one layer of a five-layer execution path. The suite
goes green, the coverage report says 100%, and the regression ships in the layer below.

So the categories are these, and they are treated differently:

| Category | What it is | How this stage treats it |
|---|---|---|
| **Seed** | The files the scope named | Full inventory. Every surface, as always. |
| **Reached** (callee, in-repo) | A file the seed executes, at any depth | **In scope. Readable, therefore not a black box — it is more scope.** Inventory its surfaces; Stage 2 reads its rules. |
| **Boundary** (callee, not in-repo) | A package, SDK or driver whose source is absent | An `EXT` surface with its own ID. Its behaviour is a contract, but the **call site is in the repository**, and caller behaviour on success and on each failure mode is fully testable. |
| **Impacted** (caller) | A file outside the closure that imports into it | Recorded as regression scope. Not inventoried as new surfaces, but named — a change to the seed can break it, and the scope never mentioned it. |

### Run the closure first, before confirming any candidate

```bash
node tools/depgraph/cli.js --repo <REPO> --scope src/checkout
```


This prints the closure to stdout: reached files by depth, the internal call
graph with call-site lines, external boundaries with their failure modes, impacted callers, and
every edge that could not be resolved.

**Exit 2 means the closure is a floor, not a picture.** A depth cap, a file cap, or an unresolvable
edge — an injection token, a computed import, a reflective lookup. Each is a piece of the execution
path the graph does not contain, so each becomes a row in **Gaps**. Raise `--depth` and re-run
before accepting a truncation.

**Exit 1 saying the scope matched no source file** is a mistyped path far more often than an empty
module. Report it and ask; never widen to `full-repo` silently.

### What this changes about the inventory

- The **denominator** is the reached set, not the seed. **Surface Inventory** states both.
- A reached file is inventoried at **full depth**. A validator three hops down is exactly as much a
  source of test cases as one in the seed, because the same request executes both.
- Every boundary becomes an `EXT` row (§4). This is usually where the case count grows most, and it
  is precisely the growth a scope-filtered run silently omitted.
- Impacted callers go in **Codebase Map** under blast radius, with their call sites.

### When only the seed is genuinely wanted

A user may legitimately want the seed alone — a quick smoke suite for one endpoint with everything
below it stubbed. That is a valid request and this stage honours it. What it must never do is
**arrive there by accident.** If the closure is deliberately not followed, say so in
**Codebase Map**, name the depth used, and record every unfollowed callee as `Out-of-Scope` so the
coverage report cannot present a partial execution path as a complete one.


# 4. What counts as a surface

A **testable surface** is any boundary at which the system accepts input, produces output, or changes state, and which a test can address directly.

| Kind | A surface of this kind is… | Typical evidence |
|---|---|---|
| `API` | One HTTP/GraphQL/gRPC/RPC operation — **one method+path pair, not a controller** | route registration, decorator, handler export |
| `UI` | One screen, route, or self-contained interactive component (a form, a table with filters, a modal) | router config, page/component file, form element |
| `JOB` | One scheduled task, cron entry, or queue worker | `@Cron`, `@Scheduled`, task registration, worker construction |
| `MSG` | One consumed topic/queue/event, or one published event contract | listener decorator, `subscribe`/`consume` call |
| `CLI` | One command or subcommand | command registration, argument parser |
| `LIB` | One exported public function/class of a library package — only when the package IS the product | package entry point, `exports` map |
| `DB` | One persisted entity, plus its constraints and migrations | model/entity definition, schema file, migration |
| `AUTH` | One authentication mechanism or authorization policy that gates other surfaces | guard, middleware, policy definition |
| `CFG` | One configuration key or feature flag that changes behaviour | env read, flag lookup, config schema |
| `EXT` | One **unreadable dependency** the closure reaches — a package, SDK, driver or remote service whose source is not in this repository | the import, plus each call site from the dependency-closure data |

**Granularity rule.** One surface = one thing a test can address on its own. `POST /orders` and `GET /orders` are two surfaces, not one `OrdersController`. A page with three independent forms is one `UI` surface for the page and one per form only if each form submits independently.

`AUTH`, `DB`, and `CFG` are surfaces in their own right *and* attributes of others: a route's `Auth` column names the `AUTH` surface that gates it. Recording both is what lets Stage 3 generate one authorization test per role boundary instead of a vague "check permissions" note.

`EXT` is the kind a scope-filtered run never produces, and it is where a sub-scope suite gains most
of its real coverage. One row per unreadable dependency, addressed at its **call sites** rather than
at the package: a test drives the caller and controls the dependency, so the call-site line is the
entry point and `Outputs` enumerates the failure modes the boundary can produce. `tools/depgraph`
supplies both — take the role, the failure-mode list and the isolation level from the dependency-closure data
rather than inventing them.

A dependency that is imported but **never called** on any walked path is recorded with
`Side Effects: None (imported, never invoked)` and needs no test. Saying so explicitly is what stops
it being quietly counted as covered.

# 5. Workflow

Run the phases in order. Each ends with a written artifact; nothing is held only in reasoning.

## 5.1 Phase A — Sweep and closure (mechanical, 2 commands)

**First, the surface sweep:**

```bash
node tools/recon_scan/cli.js --repo <REPO>
```

This prints the scan to stdout: the file census, the manifest-derived stack, inferred module boundaries, existing tests, schema sources, and **candidate** surfaces with `path:line`. Add `--json` for the full structured report.

Read its `skipped` block before anything else. Whatever is listed there was not searched, and any conclusion drawn later inherits that hole.

**The scan output is a worklist, not a finding.** Exit code 2 means a detector hit its cap or a path was unreadable — the candidate list is then incomplete and you must say so in **Gaps**.


**Second, the dependency closure** — mandatory whenever the scope is narrower than `full-repo`,
and useful even for a full-repo run because it produces the `EXT` boundary list and the internal
call graph:

```bash
node tools/depgraph/cli.js --repo <REPO> --scope <scope>
```

This prints the closure to stdout; add `--json` for the structured report. Read its **What Stage 1 must inventory**
section before confirming a single candidate: it names the files this stage is responsible for, and
that list is usually larger than the scope the user typed.

| Exit | Means | Do |
|---|---|---|
| 0 | Every edge resolved, no cap hit | Proceed. The reached set is the denominator. |
| 1 | Scope matched nothing | Report and ask. Never widen silently. |
| 2 | Truncated or an edge unresolvable | Raise `--depth` and re-run. If still incomplete, one **Gaps** row per unresolved edge, and the inventory says the closure is a floor. |

## 5.2 Phase B — Orient

Read, in this order, and record what each tells you:

1. **Manifests** (`package.json`, `pyproject.toml`, `pom.xml`, `go.mod`, …) — the stack, and crucially the **validation library**, the **ORM**, and the **authorization mechanism**. Those three decide where Stage 2 will find its rules.
2. **Entry points** — `main`, `index`, `app`, `Program.cs`, `wsgi`, the `bin`/`scripts` block, `Dockerfile` `CMD`, `docker-compose` services. A repository with three entry points is three deployables and probably three modules.
3. **Routing/registration roots** — the file where routes, jobs, and consumers are wired up. This is the single highest-value file in most backends: it is the closest thing to a table of contents for `API`, `JOB`, and `MSG` surfaces.
4. **Configuration** — env schema, config module, feature flags, `.env.example`. Behaviour that varies by config is behaviour that needs a test per documented state.
5. **Existing tests** — what is already covered, and what the team's fixtures and helpers already provide. Stage 3 complements this; it does not duplicate it.

## 5.3 Phase C — Confirm every candidate

For each candidate from Phase A, **open the file at the line** and decide:

- **Confirmed** — it is a real, reachable surface. Record it.
- **Rejected** — commented out, dead, a fixture, a re-export, a duplicate of a surface already recorded. Record nothing, but keep the count.
- **Uncertain** — it looks live but reachability depends on something source cannot settle. Record it as a surface **and** raise a gap.

Then close the coverage of the search itself:

- **Walk the registration roots exhaustively.** Every route in the router file becomes a row, whether or not the sweep found it. A regex misses dynamically registered routes, spread operators, and generated route tables; reading the registration root does not.
- **Follow each layer down one level.** Route → controller → service. You are not documenting the internals; you are confirming the surface is real and finding the file Stage 2 will need.
- **Search the domain vocabulary.** Take the nouns from the models (`Order`, `Promotion`, `Refund`) and search for each. This finds the surfaces whose names no pattern would predict.

## 5.4 Phase D — Partition into modules (a LABEL, not a folder)

Use, in priority order: an explicit monorepo layout (`apps/*`, `packages/*`, `services/*`); the deployables found at Phase B; the domain grouping of the surfaces themselves. The scan's inferred modules are a suggestion — override them when the domain says otherwise.

**One run covers the whole scope.** The partition is a `Module` **column** on every surface row, carried downstream to the traceability row and then to a column in the single exported CSV. It is not a set of separate inventories and not a set of separate suites.

This matters because the tester is the customer of the output. They want one file they can filter by module, where a total is a real total. Splitting the scope six ways gives them six partial totals and no scope-wide number at all.

| Do | Do not |
|---|---|
| Produce one **Surface Inventory** for the scope, with a `Module` value on every row | Produce one inventory per module |
| Keep `SF-` IDs unique across the **whole scope** | Restart numbering per module |
| Split into two *runs* — each its own scope, folder and suite — when the scope is genuinely too large to review | Split one run's output into per-module folders |

Aim for a module that accounts for **20–120 test cases** within the suite. That range is a review-effort guide for the partition, not a licence to split the output: larger and the module's slice of the suite is unreviewable, smaller and traceability costs more than it returns. Record the chosen partition and the reason for it.

## 5.5 Phase E — Write the artifacts

**Codebase Map**, **Surface Inventory**, **Gaps** - all carried in context, none written to disk. Formats in §7.

# 6. Evidence rules

**Every row of every table cites `path:line`.** Relative to the repository root, with a line number, e.g. `src/checkout/checkout.controller.ts:73`. A range (`:73-91`) is allowed where the behaviour genuinely spans lines.

| Rule | Why |
|---|---|
| Cite the **defining** line, not the importing one | Stage 4's drift detector hashes evidenced files; citing the import means a change to the real logic goes unnoticed. |
| Cite **each** relevant location, comma-separated | A route whose validation lives elsewhere has two pieces of evidence, and both must be watched for drift. |
| Never cite a line you have not read | The citation is the claim. An unread citation is a fabricated one. |
| Never cite a test file as evidence of product behaviour | A test asserts what someone believed; the product code is what happens. |

**Confidence,** recorded per row:

| Value | Means |
|---|---|
| `Confirmed` | Read directly in source. The line says it. |
| `Inferred` | Follows from a framework convention that is itself evidenced (e.g. a NestJS `@Controller('orders')` + `@Get(':id')` composing to `GET /orders/:id`). State the convention. |
| `Assumed` | Neither. Must have a matching row in **Gaps**. |

# 7. Output formats

## 7.1 **Surface Inventory**

The table **must** be preceded by its marker — the exporter reads it by marker, and a table without one is matched by header signature and warned about.

```markdown
# Surface Inventory — {{MODULE}}

Scope: {{scope}} · Repository: {{repo}} · Commit: {{sha}}
Confirmed surfaces: {{n}} · Candidates rejected: {{m}} · Gaps raised: {{g}}

| Surface ID | Kind | Name | Module | Entry Point | Auth | Inputs | Outputs | Side Effects | Confidence | Source Evidence |
|---|---|---|---|---|---|---|---|---|---|---|
| SF-API-011 | API | Submit checkout | Checkout | `POST /api/checkout` | Bearer, role=customer | cartId, promoCode | 201 order; 422 validation; 409 conflict | Creates an order row; decrements stock | Confirmed | src/checkout/checkout.controller.ts:73 |
```

Column rules:

- **Module** — mandatory on every row. The partition from Phase D, carried as a label. It becomes the column a tester filters the single exported CSV by, so a blank here propagates all the way to an unattributable test case.
- **Surface ID** — `SF-<KIND>-<NNN>`, zero-padded, unique across the **whole scope** (not merely within a module, since one suite covers them all), **stable across re-runs**. A re-run that renumbers surfaces breaks every downstream traceability row. When a surface disappears, retire its ID; never reuse it.
- **Entry Point** — how a test addresses it: the method+path, the route, the cron expression, the topic name, the command line.
- **Auth** — the mechanism and the role(s), or `None (unauthenticated)`, or `Unknown — GAP-nnn`. Blank is not an allowed value: blank reads as "no auth" and that is exactly the mistake this column exists to prevent.
- **Inputs** / **Outputs** — parameter and response names, and every status code or outcome the code can produce. This is where Stage 3's negative cases come from, so an incomplete Outputs cell silently removes tests.
- **Side Effects** — what changes: rows written, events published, mail sent, files stored, caches invalidated. Stage 3 turns this into the isolation level that decides what can run in parallel. `None` is a real, useful value.

## 7.2 **Codebase Map**

Prose plus small tables. Required sections:

1. **Stack** — languages, frameworks, and specifically the validation library, ORM, auth mechanism, and test tooling already present.
2. **Topology** — deployables, entry points, how they are started, what they depend on.
3. **Module partition** — the chosen modules, their paths, surface counts, and why the partition was drawn there.
4. **Layering** — where behaviour is decided in this codebase (route → controller → service → repository, or whatever it actually is). Name the layer Stage 2 should read for rules.
5. **Cross-cutting mechanisms** — auth, validation, error handling, transactions, feature flags, i18n. One line each, with evidence.
6. **What was searched** — file counts, the denominator, and the `skipped` block from the scan, restated as prose. A reviewer must be able to see the shape of the hole.

## 7.3 **Gaps**

```markdown
| Gap ID | Area | Question | Impact | Assumption Taken | Confidence | Source Evidence |
|---|---|---|---|---|---|---|
| GAP-003 | Checkout auth | Is `POST /api/checkout` reachable without a session when `GUEST_CHECKOUT=true`? | Determines whether an unauthenticated negative case is valid | Treated as authenticated-only; guest path recorded as untested | Assumed | src/checkout/checkout.controller.ts:73, src/config/flags.ts:12 |
```

A gap is raised whenever source cannot settle a question that changes a test. Recording the assumption is mandatory — an unstated assumption becomes an unexplained test failure three weeks later.

# 8. Coverage of the investigation

Report a denominator, always. "40 surfaces found" is unfalsifiable; "40 confirmed from 63 candidates across 218 of 231 source files, 13 not searched (listed)" can be checked.

**Surface Inventory** must state:

- confirmed surfaces, by kind
- candidates rejected, and the commonest reason
- files searched / files present
- anything not searched, and why
- registration roots read exhaustively (list them) — this is the claim that the `API`/`JOB`/`MSG` inventory is complete rather than sampled

And, whenever the scope was narrower than `full-repo`, the closure denominators too — without
these a sub-scope inventory cannot be checked at all:

- **seed files / reached files** — how much the scope named versus how much it executes
- **maximum depth reached**, and whether the walk was truncated
- `EXT` **boundaries found**, and how many are exercised on a walked path
- **impacted callers** outside the closure
- **unresolved edges** — each one a piece of the execution path the inventory does not contain

# 9. Stop conditions

Recognising one is never a reason to abandon the run. Do everything unaffected, then report.

| Condition | Response |
|---|---|
| Repository is not readable / is a build artifact | Stop and report. There is nothing to investigate. |
| No manifest and no recognisable entry point | Continue with a file-census-driven sweep; state plainly that the stack is undetermined and confidence is reduced throughout. |
| A generated or vendored tree dominates the repo | Exclude it, name it, and say what it would have contributed. |
| Scope names a path that does not exist | Report it, then ask. Do not silently widen to `full-repo`. |
| The sweep hit a detector cap | Re-run that detector with a raised `--max-hits`; if still capped, record the cap in **Gaps**. |
| The closure exited 2 (truncated) | Raise `--depth` and re-run. If it still truncates, inventory what was reached, list the unexplored frontier, and state that the execution path is only partly covered. |
| The closure reports unresolved edges | One **Gaps** row each. The path beyond an unresolved edge is unknown, so any case that assumes it is a guess. |
| The closure pulls in far more than expected | Do not silently narrow. Report the reached count, then ask whether to split the module or cap the depth. |
| A module exceeds ~120 candidate surfaces | Split it and say so. A suite nobody can review is not coverage. |

# 10. Handoff contract to `behavior-spec`

Stage 2 may begin when all of the following are true. State them explicitly at the end of the run.

- [ ] **Surface Inventory** exists — ONE for the whole scope — and every row has a `SF-` ID, a `Module`, a Confidence, and `path:line` evidence
- [ ] No row has a blank `Auth` cell
- [ ] **Codebase Map** names the validation library, the authorization mechanism, and the layer where rules live
- [ ] **Gaps** exists — empty is a legitimate value, absent is not
- [ ] The denominator is reported and the unsearched set is named
- [ ] Existing tests are listed, so Stage 3 complements rather than duplicates them
- [ ] For a sub-scope run: **Dependency Closure** exists, and every **reached** file has been
      inventoried — not only the seed
- [ ] Every `EXT` boundary from the closure has a surface row, with its failure modes in `Outputs`
- [ ] Impacted callers are named in **Codebase Map** as regression scope
- [ ] Every unresolved edge has a `GAP-` row

# 11. Allowed tools

Read, Grep/search, Glob, and `node tools/recon_scan/cli.js`. Git history is readable for context (`git log`, `git blame`) — it is source, not observation.

**Not allowed:** running the application, executing its test suite, any network call, any browser, any write to the target repository.

# 12. Anti-patterns

| Anti-pattern | Why it is wrong |
|---|---|
| Recording a controller as one surface | Its five routes have five different inputs, outputs, and authorization rules. One row hides four surfaces. |
| Leaving `Auth` blank because it wasn't obvious | Blank reads as "no auth required" downstream. Write `Unknown — GAP-nnn`. |
| Citing the grep hit without opening the file | The commonest way a commented-out route becomes a test case. |
| Guessing an output status code from convention | `Outputs` drives the negative cases. A guessed 404 that is actually a 200-with-null produces a test that fails on correct code. |
| Renumbering `SF-` IDs on a re-run | Silently invalidates every traceability row written against the old numbering. |
| Reporting "complete" after a capped scan | The one claim this stage must never make falsely. |
| Writing inside the target repository | The repo under investigation is read-only. Artifacts go to the output root. |
| Writing one output folder per module | The partition is a column, not a directory. Per-module folders give the tester six partial totals and no scope-wide number. |
| Leaving `Module` blank on a surface row | It propagates: the surface's test cases end up unattributed in the one CSV the tester filters. |
| Treating a sub-scope as a filter | The single most expensive mistake available here. Everything the scope calls goes untested, so the suite covers one layer of the execution path and reports it as complete. |
| Stubbing an in-repo callee | It is readable. Reading it costs minutes and turns an assumption into an evidenced rule; stubbing it discards the rules it enforces. |
| Recording an external dependency without its call sites | The package is not the surface — the line where the caller invokes it is. Without that line there is nowhere to drive the test or inject the failure. |
| Ignoring impacted callers | They execute the code under test without being named by the scope. A change that breaks them passes a suite that ignores them. |
| Reporting a truncated closure as complete coverage | Same failure as reporting a capped sweep as complete, one layer further out. |
