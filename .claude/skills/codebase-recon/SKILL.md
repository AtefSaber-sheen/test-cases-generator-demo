---
name: codebase-recon
description: Stage 1 of test generation from a codebase alone. Maps an unfamiliar repository - backend, frontend or both - into a stack profile, a module partition and an exhaustive inventory of TESTABLE SURFACES, every row evidenced by `path:line`. Static only: no running application, no API calls, no browser, no network. Use when starting test design for a repository, bringing a new service or module under test, or refreshing a surface inventory after significant development.
inputs:
  - name: repository
    type: directory_path
    required: true
    description: Root of the codebase. Read-only.
  - name: scope
    type: string
    required: false
    description: "`full-repo` (default), a module path, or a change scope (`diff:main`, a branch, a file list). A narrower scope is a SEED, not a filter: its dependency closure is inventoried too."
outputs:
  - name: codebase_map
    type: in_context
    description: Stack, topology, module partition, layering, cross-cutting mechanisms, blast radius. HELD IN CONTEXT.
  - name: surface_inventory
    type: in_context
    description: One row per confirmed testable surface, stable `SF-` ID, `path:line` evidence. HELD IN CONTEXT. Stage 3 coverage denominator.
  - name: gaps
    type: in_context
    description: What source could not settle, with the assumption taken. HELD IN CONTEXT.
  - name: dependency_closure
    type: in_context
    description: depgraph output - reached files, call graph, EXT boundaries with failure modes, impacted callers, unresolved edges. HELD IN CONTEXT.
dependencies:
  - Node.js >= 18
  - Read / Grep / Glob
---

> Stage 1 of 4 — **`codebase-recon`** → `behavior-spec` → `test-design-from-code` → `suite-export`. Chain of custody: `file:line → Surface → Use Case / Business Rule → Test Case → CSV row`. A broken link is a fabrication.

## Constraints

No running application: source, manifests, config and git history are the entire evidence base. Nothing is observed, everything is read — "returns 404" is sayable only if you read the line returning 404. Absence of evidence is reportable: undeterminable auth goes to **Gaps**, never "presumably authenticated". Static reachability is not runtime reachability — a route behind a disabled flag looks live, so note the doubt rather than resolving it silently. **Never** start the app, run its suite, call an endpoint, open a browser, touch the network, or write to the target repo.

## Scope is a seed, not a boundary

| Category | Treatment |
|---|---|
| **Seed** — files the scope named | Full inventory |
| **Reached** — in-repo callee, any depth | **In scope**: readable, so more scope, not a black box. Inventory at full depth; never stub it |
| **Boundary** — callee with no source here | One `EXT` surface addressed at its **call sites**; caller behaviour per failure mode is testable |
| **Impacted** — caller outside the closure | Regression scope, named in Codebase Map with call sites |

The denominator is the reached set, not the seed — state both. Treating a sub-scope as a filter leaves everything it calls untested while the report reads 100%. Seed-only is honoured when explicitly asked for: name the depth used, record unfollowed callees as `Out-of-Scope`.

## Surfaces

One surface = one thing a test can address alone (`POST /orders` and `GET /orders` are two, not one `OrdersController` — one row there hides four surfaces, and coverage still reads 100%).

`API` one method+path · `UI` one screen/route/self-contained component · `JOB` one task/cron/worker · `MSG` one consumed or published topic · `CLI` one command · `LIB` one exported public function (only when the package is the product) · `DB` one entity with constraints and migrations · `AUTH` one mechanism or policy · `CFG` one key or flag that changes behaviour · `EXT` one unreadable dependency the closure reaches.

`AUTH`/`DB`/`CFG` are surfaces *and* attributes of others: a route Auth cell names the `AUTH` surface gating it. For `EXT`, take role, failure modes and isolation from the closure data — never invent them, and never record one without its call sites, since the call line is where a test drives it. Imported but never called on a walked path is `Side Effects: None (imported, never invoked)`.

## Workflow

**A. Sweep and closure.** Closure is mandatory below `full-repo`, useful even at full-repo (it produces the `EXT` list and call graph). Both print to stdout; `--json` for structure.

```bash
node test-cases-generator-demo-tools/recon_scan/cli.js --repo <REPO>
node test-cases-generator-demo-tools/depgraph/cli.js  --repo <REPO> --scope <scope>
```

Read the scan `skipped` block and the closure "What Stage 1 must inventory" section before confirming any candidate. Scan output is a worklist, not a finding. Exit **0** proceed · **1** scope matched nothing, usually a typo (report and ask, never widen silently) · **2** truncated/capped/unresolvable edge (raise `--depth`/`--max-hits` and re-run; if still incomplete, one **Gaps** row per unresolved edge and state the closure is a floor, not a picture).

**B. Orient.** Manifests (the validation library, ORM and auth mechanism decide where Stage 2 finds rules) → entry points (`main`, `wsgi`, `bin`, Dockerfile CMD, compose services) → routing/registration roots (the table of contents for `API`/`JOB`/`MSG`) → config and flags → existing tests (Stage 3 complements, never duplicates).

**C. Confirm each candidate** by opening the file at the line: **Confirmed** (record) · **Rejected** (dead, commented, fixture, re-export, duplicate — keep the count) · **Uncertain** (record the surface *and* raise a gap). Citing a grep hit unopened is how a commented-out route becomes a test case. Then walk registration roots exhaustively (a regex misses dynamic, spread and generated routes), follow route→controller→service one level down, and search the domain vocabulary from the models.

**D. Partition into modules** — a `Module` **column**, never a folder, so the tester filters one file where a total is a real total. Priority: monorepo layout → deployables → domain grouping. `SF-` IDs unique scope-wide, never renumbered per module. Aim ~20–120 cases per module; when a scope is too large to review, split into two *runs*, never one run into folders.

**E. Emit** Codebase Map, Surface Inventory, Gaps — in context, never to disk, never inside the target repo.

## Evidence and output formats

Every row cites repo-relative `path:line` (`src/checkout/checkout.controller.ts:73`; a range where behaviour genuinely spans lines). Cite the **defining** line, not the import; cite each relevant location comma-separated; never cite a line you have not read; never cite a test file as evidence of product behaviour. Confidence: `Confirmed` (read it) · `Inferred` (an evidenced framework convention — name it) · `Assumed` (**requires** a matching `GAP-` row).

**Surface Inventory** — marker heading `# Surface Inventory — {{MODULE}}`, then scope/repo/commit and counts of confirmed/rejected/gaps, then rows of:

`| Surface ID | Kind | Name | Module | Entry Point | Auth | Inputs | Outputs | Side Effects | Confidence | Source Evidence |`

- **Surface ID** `SF-<KIND>-<NNN>`, unique scope-wide, **stable across re-runs**; retire, never reuse or renumber — renumbering invalidates every downstream traceability row.
- **Module** mandatory; a blank ends as an unattributable test case. **Entry Point** how a test addresses it: method+path, route, cron expression, topic, command line.
- **Auth** mechanism and roles, or `None (unauthenticated)`, or `Unknown — GAP-nnn`. **Blank is not allowed** — it reads as "no auth" downstream.
- **Inputs/Outputs** every parameter, and every status code or outcome the code can produce. An incomplete Outputs cell silently removes Stage 3 negative cases; a code guessed from convention produces a test that fails on correct code.
- **Side Effects** rows written, events, mail, files, caches — becomes Stage 3 isolation. `None` is a real value.

**Codebase Map**: Stack (incl. validation library, ORM, auth, test tooling) · Topology · Module partition and why · Layering (name the layer Stage 2 reads for rules) · Cross-cutting mechanisms · What was searched (counts plus `skipped` as prose) · Blast radius.

**Gaps**: `| Gap ID | Area | Question | Impact | Assumption Taken | Confidence | Source Evidence |` — raised whenever source cannot settle something that changes a test. Recording the assumption is mandatory.

## Denominator and stop conditions

Always report: confirmed by kind · candidates rejected and commonest reason · files searched/present · what was not searched and why · registration roots read exhaustively **by name**. Below `full-repo` add seed/reached files · max depth and whether truncated · `EXT` boundaries and how many are on a walked path · impacted callers · unresolved edges. Never claim "complete" after a capped scan or truncated closure. Never abandon the run — do everything unaffected, then report. Unreadable repo or build artifact → stop. No manifest or entry point → census-driven sweep, state the stack is undetermined. Vendored tree dominates → exclude, name it, say what it would have contributed. Scope path missing → report and ask. Closure far larger than expected → report the count and ask whether to split or cap depth, never narrow silently. Module over ~120 candidates → split and say so.

## Handoff — state explicitly

ONE Surface Inventory for the scope, every row with `SF-` ID + `Module` + Confidence + `path:line` · no blank `Auth` · Codebase Map names validation library, auth mechanism and rule layer · **Gaps** exists (empty is legitimate, absent is not) · denominator reported and unsearched set named · existing tests listed · sub-scope run: every reached file inventoried, not just the seed · every `EXT` boundary has a row with failure modes in `Outputs` · impacted callers named as regression scope · every unresolved edge has a `GAP-` row.
Allowed: Read, Grep, Glob, the two node tools, `git log`/`git blame` (source, not observation). Nothing else.
