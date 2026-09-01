---
name: test-design-from-code
description: Stage 3 of test generation from a codebase alone. Turns the evidenced behaviour specification into a complete, execution-ready test suite — full procedures, concrete test data derived from the code's own constraints, every applicable test type evaluated per surface, plus per-case execution profile (layer, oracle, fixtures, isolation) and full traceability back to `path:line`. Hands Stage 4 the case set it renders to the deliverable CSV and report. Use when designing or extending a test suite for a module whose behaviour spec exists.
inputs:
  - name: behavior_spec
    type: in_context
    required: true
    description: The Stage 2 specification - use cases, business rules and data contracts. Carried in context, not read from disk.
  - name: surface_inventory
    type: in_context
    required: true
    description: The Stage 1 surface inventory - the coverage denominator.
  - name: gaps
    type: in_context
    required: true
    description: The accumulated gaps - every assumption a case may rest on.
  - name: dependency_closure
    type: in_context
    required: false
    description: The Stage 1 dependency closure. Supplies the EXT boundaries with their failure modes and isolation levels, the depth of each rule in the call graph (which decides the test layer), and the impacted callers that need regression cases. Required in practice for any scope narrower than the whole repository.
  - name: existing_tests
    type: in_context
    required: false
    description: The existing-tests list from Stage 1's recon scan, so the designed suite complements rather than duplicates them.
outputs:
  - name: test_suite
    type: in_context
    description: The authored case set - every case in the scope, with the twelve fields plus layer, entry point and oracle. HELD IN CONTEXT, not written to disk. Stage 4 renders it as the CSV.
  - name: test_data
    type: in_context
    description: Concrete datasets, one row per field, each value derived from a code constraint and evidenced. HELD IN CONTEXT. Rendered into the Stage 4 report's Test data section.
  - name: execution_profile
    type: in_context
    description: Per case - layer, entry point, oracle, fixtures, teardown, isolation, determinism. Isolation is what makes the parallel plan possible. HELD IN CONTEXT. Layer, entry point and oracle reach the CSV; the rest reaches the report's Execution profile section.
  - name: traceability_matrix
    type: in_context
    description: Test Case to Use Case / Business Rule / Surface / `path:line`, with risk and confidence. HELD IN CONTEXT. Rendered into the Stage 4 report's Traceability matrix.
  - name: coverage_report
    type: in_context
    description: Per-item coverage status with reasons, and the per-surface evaluation of every test type. HELD IN CONTEXT. Rendered into the Stage 4 report's coverage sections.
dependencies:
  - codebase-recon (upstream skill)
  - behavior-spec (upstream skill)
---

> **Pipeline position:** Stage 3 of 4 — `codebase-recon` → `behavior-spec` → **`test-design-from-code`** → `suite-export`.
> **Derivation rule:** nothing this stage produces is written to disk. It is held in context and rendered by Stage 4 into exactly two files - one CSV of cases, one Markdown report.

# 1. Purpose

Produce a suite that a human tester can execute against the **running system** without asking a question, and that an automation or agentic runner can execute without parsing prose — covering every applicable test type against every surface, with test data taken from the code's own constraints rather than invented.

**One scope, one suite.** Every case in the scope belongs to one case set, which Stage 4 renders to a single CSV. Modules are a **column**, not a file. §2.1 says why.

# 2. Three properties every case must have

**Executable.** A new QA engineer, given only the case, can run it. Every value they need is in it. Nothing is "as appropriate".

**Tester-executable — through the API or the UI.** The person running this suite has a deployed system, an HTTP client and a browser. They do **not** have the source checked out, a test harness, or a way to call a function directly. See §2.2; this is the property most easily lost.

**Traceable.** Every case cites a use case or business rule, a surface, and the `path:line` that proves the expected result. A case whose expected result cannot be traced to a line of code is asserting an opinion.

A case that fails any of the three is not shipped, however sensible it looks.

## 2.1 One suite for the whole scope

A tester covering an area does not want six spreadsheets. They want one file they can filter, sort and
sign off, and one place where a total is a real total.

| Rule | Why |
|---|---|
| One case set per run, holding **every** case in the scope | A tester filters a column; they cannot filter across six files. Splitting the suite by module means every count is per-file, and the scope-wide number nobody computes is the only one that answers "are we covered?" |
| The module is a **column on the traceability row**, never a folder and never a case field | The twelve-field case block is a fixed contract (§3). A `**Module:**` line is not a thirteenth column — it is silently absorbed into the previous field and warned about by Stage 4. |
| Every case has a `Module` value | It is how the tester narrows the CSV to the area they own. A blank is reported by Stage 4, because an unattributed case is missing from every per-module total while still inflating the overall one. |
| Test Case IDs stay module-prefixed (`TC-CHK-002`, `TC-PROMO-011`) | One document, one namespace. The prefix keeps IDs readable and collision-free, and keeps the traceability that already exists against them intact. |
| Cases are grouped by module under `## {{Module}}` headings, in a stable order | A 400-case document needs structure. The headings are for the reader; the parser keys off the `###` case headings and is unaffected. |

**A scope large enough to produce thousands of cases is a scope that should have been split at Stage 1** — and split into two *runs*, each with its own folder and its own suite, not into two files in one folder. Say so rather than quietly emitting a document nobody can review.

## 2.2 The layer rule — black-box only

**Allowed layers: `API`, `UI`, `E2E`, `Contract`. `Unit` and `Component` are not test layers in this suite.**

The audience for this suite is a software tester working against a deployed system. A `Unit` case asks them to check out the repository, wire up a harness, and invoke a function — which they will not do, so the row is skipped. A skipped row still counts as coverage in every total, and that is the failure: the suite reports a rule as covered while nobody has ever exercised it.

So a rule enforced deep in the call graph is **pulled up, not tested down**:

| Situation | What to do |
|---|---|
| A rule is enforced three hops below the entry point | Drive it through the endpoint or screen whose request reaches it. The evidence still cites the deep `path:line`; the *entry point* is the surface a tester can address. |
| Several endpoints reach the same deep rule | Cover it through **each** of them where the observable outcome differs, because the callers map the same failure differently — that difference is the behaviour. |
| The rule's effect is not observable in any response | Assert it where it *is* observable: a persisted row, an emitted event, a subsequent read through another endpoint. Name that oracle. |
| **No endpoint, screen, job, message or command reaches it at all** | Record it in the coverage report as `Unreachable-Black-Box`, with the reason and the `path:line`. **Do not write a unit case.** Unreachable-from-outside is a genuine finding — it is either dead code or a missing surface, and both are worth more to the team than a test QA cannot run. |

The old instinct — "test it at the cheapest layer that can observe it" — optimizes for a developer's test pyramid. This suite optimizes for a person with a browser and Postman. When a rule is reachable through the entry point, `API` **is** the cheapest layer that can observe it for that person.

`Contract` stays allowed because a tester can validate a response against a schema with the same HTTP client they already have.

Stage 4 checks this: any other `Layer` value is reported in the report's Warnings section, naming the case.

# 3. The test case schema — exactly twelve fields, in this order

```markdown
### TC-CHK-002 — Reject a promo code past its expiry date

**Objective:** Verify that a promo code whose expiry date has passed is rejected and leaves the total unchanged.

**Preconditions:** A cart containing one item priced 100.00 exists for an authenticated customer.

**Test Data:**

| Field | Value |
|---|---|
| promoCode | `WINTER5` |
| expiresAt | `2025-01-31T23:59:59Z` (past) |

**Steps:**

1. Submit the cart to `POST /api/checkout`.
2. Supply the promo code `WINTER5`.

**Expected Result:** The request is rejected with HTTP 422 and error code `PROMO_EXPIRED`; the payable total is unchanged at 100.00 and no order row is created.

**Priority:** P2

**Tags:** Atomic, Negative-Temporal, BusinessRule

**Notes:** Expiry is compared against server time, not client time.

**Review:** Pending

**Automation:** Pending
```

**The field list is a contract, not a preference.** `Test Case ID · Title · Objective · Preconditions · Test Data · Steps · Expected Result · Priority · Tags · Notes · Review · Automation`. It is byte-identical to the Agentic AI Testing Platform's Stage 3 schema, which is what makes a suite written here a drop-in for that pipeline.

**Never invent a thirteenth field.** A `**Surface:**` line does not become a column — it is appended to the previous field's text and warned about by Stage 4. Everything extra goes in the report sections (§7–§9).

Field rules:

| Field | Rule |
|---|---|
| **ID** | `TC-<MODULE>-<NNN>`, unique, **stable across re-runs**. Retire IDs; never reuse them. |
| **Title** | Short, specific, scannable. States the behaviour, not the mechanics. |
| **Objective** | ONE sentence: what this verifies. Not a restatement of the requirement. |
| **Preconditions** | Only what must be true *immediately before* step 1. Not setup narrative. |
| **Test Data** | The values the steps actually reference — never values they don't. Omit the field entirely when there is none. Inline for one or two values; a Field/Value table for more. |
| **Steps** | ONE action per step. Actions only — verification belongs in Expected Result. "Click Save and check the message" is two things: split it. |
| **Expected Result** | The specific, OBSERVABLE outcome that constitutes a pass, including status/code, the value, and the postcondition. |
| **Priority** | `P1`–`P4`, per §11. |
| **Tags** | The granularity tier (exactly one) plus the test types. See §5. |
| **Notes** | Optional, genuinely useful context only. Never a hiding place for a step or a value. |
| **Review** | Always literally `Pending`. No skill may write any other value. |
| **Automation** | Always literally `Pending`. Same rule. |

`Review` and `Automation` record **human** decisions taken after generation. A skill that advances its own review status has reviewed its own work, which is the one thing those columns exist to prevent.

## 3.1 Granularity tier — exactly one per case

| Tier | Is | Rule |
|---|---|---|
| `Atomic` | One business rule or one validation | The default. Most of the suite. |
| `Scenario` | One complete workflow composed of several related rules | Use when the rules only make sense together. |
| `E2E` | A business journey spanning several surfaces or screens | **Additive, never a replacement.** An `E2E` case never removes the `Atomic` cases covering the same ground. Its Objective must state the span. |

**One behaviour per case.** A case chaining unrelated actions is split. The same behaviour across several data points is still one behaviour, parameterized through several datasets (§8).

## 3.2 The readability check

Before finalizing any case: can a new QA engineer execute it unaided? Is it understandable in under 30 seconds? Is every step necessary? Does it verify exactly one thing?

**If removing a sentence does not change how the test is executed, remove it.**

# 4. Workflow

1. **Load** the spec, the surface inventory, the gaps, the existing-tests list, and — for any scope narrower than the whole repository — **Dependency Closure** and the dependency-closure data. The closure supplies the `EXT` boundaries, their failure modes and their isolation levels, so none of those has to be invented.
2. **Enumerate the flows** (§5 section K) alongside the surfaces. Flows come from the use cases, the state machines and the UI routes; they are a second denominator, not a by-product of the first.
3. **Build the evaluation grid** — every surface × every test type in §5, `EXT` boundaries and section J rows included, plus every flow × every section K row. This grid is the plan for the run and its completeness argument.
4. **For each cell:** generate the case(s), or record `Not Applicable — {one-line reason}`. **A cell is never left blank.** Every generated case is `API`, `UI`, `E2E` or `Contract` (§2.2); a rule no surface reaches becomes an `Unreachable-Black-Box` coverage row, never a unit case.
5. **Derive test data** from **Data Contracts** using the mechanical rules in §6.
6. **Write the execution profile** per case (§9). Isolation is mandatory — without it the case is scheduled `exclusive` and the parallel plan collapses.
7. **Write traceability** per case (§10), including the `Module` on every row.
8. **Assemble the one scope-wide suite** (§2.1) — all cases in the case set, grouped under `## {{Module}}` headings.
9. **Write the coverage report** (§12), including the evaluation grid and both denominators — surfaces and flows.
10. **Self-check** (§13), then hand the case set and every supporting table to `suite-export`.

# 5. The coverage engine — every type, evaluated per surface

This is the heart of the stage. For **every surface**, walk this catalogue. Generate, or record
`Not Applicable — reason`. A type is never silently skipped.

An `EXT` boundary is a surface here like any other, and section J covers what a sub-scope run owes
the layers below its seed. Both are easy to omit and both are where a scope-filtered suite loses
most of its real coverage.

The catalogue is written in HTTP vocabulary because that is the commonest case; §5.1 gives the equivalent at every other shape. A type is **never** recorded `Not Applicable` merely because the surface has no HTTP request.

## A. Functional

| # | Test type | Generate when | Tag |
|---|---|---|---|
| A1 | **Happy path** | Always, for every surface | `Positive` |
| A2 | **Alternate flow** | Per alternate flow in the use case | `Positive, AlternateFlow` |
| A3 | **Business rule, direct** | Per `BR-` row — exercised head-on, not incidentally via a positive case | `BusinessRule` |
| A4 | **Calculation accuracy** | Per `Calculation`-type rule, including its rounding behaviour | `BusinessRule, Calculation` |
| A5 | **Default applied** | Per field with a default — omit it, assert the default | `Positive, Default` |
| A6 | **Optional omitted** | Per optional field — assert the behaviour without it | `Positive, OptionalField` |

## B. Input validation — the negative matrix

Derived mechanically from **Data Contracts** (§6). One case per applicable row, per field.

| # | Test type | Generate when | Tag |
|---|---|---|---|
| B1 | **Required missing** | Field is required | `Negative-Empty` |
| B2 | **Empty / whitespace-only** | Field is a string | `Negative-Empty` |
| B3 | **Null where non-null** | Field is non-nullable | `Negative-Null` |
| B4 | **Wrong type** | Always | `Negative-Type` |
| B5 | **Boundary set** | Field has a numeric or length bound — **four values**: min−1, min, max, max+1 | `Negative-Boundary` (and `Positive` for the two inside) |
| B6 | **Pattern violation** | Field has a regex/format — one near-miss, not gibberish | `Negative-Format` |
| B7 | **Enum violation** | Field is an enum — a value outside the set, plus a case-variant | `Negative-Enum` |
| B8 | **Oversized payload** | Body/array/file has a size or count limit | `Negative-Boundary` |
| B9 | **Unicode** | Field is free text — accented Latin, CJK, RTL, emoji (supplementary plane) | `Negative-Unicode` |
| B10 | **Format-significant characters** | Always — characters meaningful in *this* encoding: `<script>`, `&`, quotes, backslashes; unescaped quotes/newlines for JSON; delimiters for CSV | `Negative-SpecialChars` |
| B11 | **Uniqueness violation** | A unique constraint exists | `Negative-Conflict` |
| B12 | **Referential violation** | A foreign key exists — reference a nonexistent parent | `Negative-Referential` |

## C. Authentication and authorization

| # | Test type | Generate when | Tag |
|---|---|---|---|
| C1 | **Unauthenticated** | Surface requires auth | `Security-AuthN` |
| C2 | **Wrong role** | More than one role exists — **one case per role boundary**, not one generic case | `Security-AuthZ` |
| C3 | **Ownership violation** | Surface addresses a user-owned resource — act on another user's record with a valid role | `Security-AuthZ, Ownership` |
| C4 | **Invalid / expired / malformed credential** | Token-based auth | `Security-AuthN` |
| C5 | **Mass assignment** | Request body maps onto an entity with fields a client should not set (`role`, `isAdmin`, `price`) | `Security-AuthZ, MassAssignment` |
| C6 | **Rate limit** | A rate limit exists | `Security-RateLimit` |
| C7 | **Injection-shaped input** | Always, as an **input-handling and error-message probe only** — never to exploit. Assert safe rejection and that no internal detail leaks | `Security-Injection` |

## D. State and lifecycle

| # | Test type | Generate when | Tag |
|---|---|---|---|
| D1 | **Legal transition** | Per edge in the transition table | `StateTransition` |
| D2 | **Illegal transition** | Per non-edge (or a representative set, stated as such) | `StateTransition, Negative` |
| D3 | **Idempotency** | Surface is a mutation — repeat the identical request | `Idempotency` |
| D4 | **Concurrency** | Two actors can mutate the same record — simultaneous requests | `Concurrency` |
| D5 | **Ordering dependence** | Behaviour depends on event/message order | `Ordering` |

## E. Error handling and resilience

| # | Test type | Generate when | Tag |
|---|---|---|---|
| E1 | **Error response shape** | Per distinct error the surface can produce — assert status, code, and shape, not just "an error" | `ErrorHandling` |
| E2 | **Boundary failure, one case per mode** | The surface reaches an `EXT` boundary — one case for **every** failure mode it can produce, never a single case for "the dependency fails". See §5.3 | `ErrorHandling, Resilience` |
| E2b | **Boundary success through the caller** | Per `EXT` boundary — the happy path across the closure, asserting the caller maps the result correctly | `Positive, Integration` |
| E3 | **Timeout** | A timeout is configured or a slow path exists | `ErrorHandling, Timeout` |
| E4 | **Rollback on partial failure** | A transaction spans several writes | `ErrorHandling, Transaction` |

## F. Data and persistence

| # | Test type | Generate when | Tag |
|---|---|---|---|
| F1 | **Persistence assertion** | Surface writes — assert the stored state, not only the response | `Persistence` |
| F2 | **Cascade / delete behaviour** | A cascade or soft-delete rule exists | `Persistence, Referential` |
| F3 | **DB-applied default** | The database supplies a default the app does not | `Persistence, Default` |
| F4 | **Migration consistency** | A migration touches a tested entity — up and, where supported, down | `Migration` |

## G. Contract

| # | Test type | Generate when | Tag |
|---|---|---|---|
| G1 | **Response schema conformance** | A response schema exists or can be derived | `Contract` |
| G2 | **Backward compatibility** | The surface is versioned or publicly consumed | `Contract, Compatibility` |
| G3 | **Event/message payload contract** | The surface publishes | `Contract, Messaging` |

## H. Interface-specific (UI surfaces)

| # | Test type | Generate when | Tag |
|---|---|---|---|
| H1 | **Initial render / default state** | Always, for a UI surface | `Positive, Rendering` |
| H2 | **Client/server validation parity** | Client-side validation exists — assert the server enforces it too | `Negative, ValidationParity` |
| H3 | **Empty / loading / error state** | The component has them — one case each | `Rendering, StateHandling` |
| H4 | **Accessibility** | Always — labels, roles, keyboard reachability, focus order, contrast tokens | `A11y` |
| H5 | **Responsive** | Layout has breakpoints | `Responsive` |
| H6 | **Internationalization** | i18n is present — externalized strings, locale number/date formatting, RTL | `I18n` |

## I. Cross-cutting

| # | Test type | Generate when | Tag |
|---|---|---|---|
| I1 | **Configuration state** | A config key or flag changes behaviour — **one case per documented state**, never an invented state | `Config` |
| I2 | **Integration of two rules** | Two rules must compose (two filters ANDing, two settings interacting) — test the *interaction*, not each side | `Integration` |
| I3 | **Observability / audit** | The code emits an audit or analytics event — assert it is emitted | `Observability` |
| I4 | **Pagination / sorting / filtering** | The surface supports them — defaults, limits, out-of-range page, invalid sort key | `Pagination`, `Sorting`, `Filtering` |
| I5 | **Performance-sensitive path** | An N+1, an unbounded query, or a documented budget exists — assert the bound, not a wall-clock number | `Performance` |
| I6 | **Regression** | A known defect or a change scope exists — assert the CORRECTED behaviour, never a restatement of the bug | `Regression` |
| I7 | **E2E journey** | Per use case spanning several surfaces — see section K, which is where journeys are actually enumerated | `E2E` |
| I8 | **Smoke** | Tag the minimal set that proves the module is alive | `Smoke` |

## J. Execution depth (a scope narrower than the whole repository)

These exist because a sub-scope suite that omits them tests one layer of a multi-layer execution
path and reports it as complete. Generate them from **Dependency Closure**.

| # | Test type | Generate when | Tag |
|---|---|---|---|
| J1 | **Deep rule, through its shallowest entry point** | A rule is enforced below the entry point — drive it through the endpoint or screen that reaches it and assert the observable outcome (§2.2). Where two entry points reach it and handle it differently, one case each. Where none reaches it, a coverage row (`Unreachable-Black-Box`), not a case | the rule type, plus `Atomic` |
| J2 | **Full-path integration** | Per use case whose closure spans ≥2 internal layers — one case driving the entry point and asserting the outcome the deepest layer decides | `Integration` |
| J3 | **Conflicting constraints across layers** | Two layers state different limits for one field — one case at the tighter limit, proving which one actually governs | `Negative, Boundary` |
| J4 | **Duplicated enforcement** | The same rule is enforced at two depths — one case per enforcement point, because removing either changes behaviour | the rule type |
| J5 | **Impacted caller regression** | A file outside the closure calls into it — one case per impacted entry point, asserting its behaviour is unchanged | `Regression` |
| J6 | **Unreached-code probe** | The closure shows a file is reachable only through a path the suite does not cover — record it as uncovered rather than generating a case that cannot be driven | — (a coverage row, not a case) |

## K. Flows and end-to-end scenarios

Sections A–J cover surfaces **one at a time**. A tester's job is not only "does this endpoint
validate its input" but "can a customer actually place an order, and what happens when they do it
the way real customers do". A suite of 300 atomic cases with no journey through them has never once
exercised the system the way it is used.

This section is therefore **not optional and not a garnish on the atomic cases.** It is enumerated
from the use case catalogue and the surface inventory, and every row below is evaluated per flow
exactly as section A is evaluated per surface.

**Enumerate the flows first.** A flow is a sequence of surfaces a real actor drives to reach an
outcome they care about. Take them from: each `UC-` whose steps touch more than one surface; each
state machine path from initial to each terminal state; each UI route sequence the router allows;
each `create → read → update → delete` cycle over an entity; each path that crosses backend and
frontend.

| # | Test type | Generate when | Tag |
|---|---|---|---|
| K1 | **Primary happy journey** | Per flow — the complete path, end to end, asserting the outcome AND the state left behind at each surface it passes | `E2E, Positive` |
| K2 | **Alternate journey** | Per legitimate variation of the flow (guest vs. logged in, saved card vs. new card, one item vs. many) — one case each, not one case with branches | `E2E, AlternateFlow` |
| K3 | **Journey interrupted mid-flow** | Per flow with ≥2 mutating steps — abandon after step *n*, then assert what persists and what does not. This is where half-written state lives | `E2E, Negative` |
| K4 | **Resume / re-entry** | The flow can be resumed (a saved cart, a draft, a returned-to checkout) — leave and re-enter, assert nothing was lost or double-applied | `E2E, StateTransition` |
| K5 | **Backward navigation and re-submission** | The flow has a UI — go back a step and submit again; assert no duplicate record and no stale value | `E2E, Idempotency` |
| K6 | **Cross-surface data consistency** | The flow writes at one surface and reads at another — assert the value the second surface reports matches what the first wrote | `E2E, Persistence` |
| K7 | **Cross-role journey** | Two actors participate (a customer orders, an admin approves) — one case driving the whole handover across both roles | `E2E, Security-AuthZ` |
| K8 | **Failure recovery journey** | Per flow reaching an `EXT` boundary — the boundary fails mid-journey, the user retries, and the journey completes. Assert no double charge, no orphan record | `E2E, Resilience` |
| K9 | **Full lifecycle of an entity** | Per primary entity — create, read, update, transition through every legal state, delete/archive, then confirm it is gone from every surface that listed it | `E2E, StateTransition` |
| K10 | **Backend/frontend contract in the journey** | The flow crosses UI and API — assert the UI reflects what the API returned, including the error path (a rejected request must surface to the user, not fail silently) | `E2E, Contract` |

**Journeys are additive.** A K-case never replaces the atomic cases over the same surfaces. When a
journey fails you learn *that* the flow is broken; the atomic case tells you *which* rule broke.
Dropping the atomic cases because "the E2E covers it" trades every diagnosis for one red tick.

**Every journey is written as one case, with numbered steps across surfaces, and one Expected
Result naming the final observable state plus each intermediate assertion.** The `Entry Point`
column names the first surface and the sequence, e.g. `POST /api/cart → POST /api/checkout → GET
/api/orders/:id`.

**Coverage denominator for this section:** flows enumerated / flows covered. Report it in the
coverage report beside the surface percentage. A suite at 100% of surfaces and 20% of flows is
not a covered system, and reporting only the first number hides it.

## 5.1 Per-shape equivalents

Each type has an equivalent at every surface shape. Use the equivalent; do not record `Not Applicable` because the row was phrased for a form field.

| Type family | API / RPC | UI | Messaging | Job / Batch | CLI |
|---|---|---|---|---|---|
| Required / empty | omitted property; `null`; empty array | blank required field; whitespace | missing envelope field | missing column; empty file | missing required flag |
| Boundary | numeric/length bound; page size; payload size | input maxlength; upload size | max message size; batch size | max rows; max file size | max argument length |
| Wrong type | wrong JSON type; wrong `Content-Type` | text in a number input | schema-violating payload | wrong column type | non-numeric where numeric |
| Unicode / special chars | multi-byte in string values | in the field, and as rendered output | in the payload | delimiters and quotes in CSV | shell-significant characters |
| AuthN / AuthZ | unauthenticated; wrong role; other user's record | route guard; hidden control still reachable | publish to a forbidden topic | job triggered by a wrong principal | command run without permission |
| Timeout | slow upstream; client timeout | slow request → loading and error state | unacknowledged / redelivered / poison message | job exceeds its window; partial write | long-running command interrupted |
| Idempotency | repeat the same POST | double-click submit | duplicate delivery of one message | job re-run on the same window | command re-run |
| Concurrency | two simultaneous writes | two tabs editing one record | two consumers, one partition | overlapping job runs | two invocations |

## 5.2 Recording non-applicability

`Not Applicable — {one-line reason}`, in the coverage report's evaluation grid. Legitimate: "surface is read-only, no state to transition". Not legitimate: "not relevant", "N/A", or silence.

## 5.3 Covering an unreadable dependency

A boundary is the one place a test designer is tempted to write a case that cannot be executed.
"Simulate a failure from the payment provider" names no failure, no injection point and no expected
result, so a runner cannot execute it and a human tester cannot either.

Everything needed to make it executable is already in the dependency-closure data and Stage 2:

| Field of the case | Comes from |
|---|---|
| **Which failure** | the boundary role failure-mode list — `declined`, `unique-violation`, `http-5xx`, not "an error" |
| **Where to inject it** | the boundary call site, `path:line` |
| **What is expected** | Stage 2 read the caller error handling — the status, the code, the fallback, the rollback |
| **Which layer** | `API` or `UI` — whichever entry point reaches the call site, with the boundary controlled through the environment the tester has (a sandbox mode, a stub upstream, a seeded failure fixture). Never `Component`: a tester cannot stub an in-process collaborator |
| **Isolation** | the boundary isolation level from the dependency-closure data — a shared sandbox is `exclusive` |

### The arithmetic

One success case plus one case per failure mode, **per calling surface** — because two surfaces
calling the same gateway can handle a decline differently, and usually do.

That number is larger than teams expect: a service with six unreadable dependencies has six failure
surfaces and typically thirty-plus cases. the dependency-closure data states the minimum per boundary. Cover it,
or record `Not Applicable` with a reason **per mode** — never silently drop the modes that are
awkward to arrange.

| Reason a mode is genuinely N/A | Example |
|---|---|
| The code path cannot produce it | a read-only query cannot hit a uniqueness violation |
| The mode is prevented upstream | an idempotency key is generated server-side, so a client replay cannot vary it |
| The dependency is not on this surface path | the boundary is reached only by a different entry point |

**Not a valid reason:** the failure is hard to arrange, the team has no sandbox, or the dependency
is assumed reliable. Those are execution problems, and they belong in Automation Notes — recording
them as `Not Applicable` converts a missing test into a false claim of coverage.

### Assert the caller, never the dependency

The case asserts what **the repository code** does. "Stripe returns a 402" is a precondition, not an
expected result. The expected result is what the caller then does: the status it returns, the error
code, whether the order row exists, whether the stock was released, whether the retry happened.

And when Stage 2 found **no handling at all**, the case asserts the behaviour that actually occurs —
a 500, a leaked message, a half-written record — with a note naming the gap. A test asserting the
sensible behaviour the code does not implement fails on unchanged code and gets deleted; a test
asserting the real behaviour with a note is the thing that gets the defect fixed.


# 6. Deriving test data from constraints — mechanically

Every value comes from a constraint in **Data Contracts**. **Never invent a value where the code states one.**

| Constraint | Values generated | Kind |
|---|---|---|
| `1 ≤ n ≤ 99` | `0`, `1`, `99`, `100` | `Boundary-Below`, `Boundary-Min`, `Boundary-Max`, `Boundary-Above` |
| `n > 0` (exclusive) | `0`, `1` — and `-1` | `Boundary-Below`, `Boundary-Min`, `Invalid-Range` |
| `maxLength 120` | `""`, 1 char, 120 chars, 121 chars | `Empty`, `Boundary-Min`, `Boundary-Max`, `Boundary-Above` |
| `^[A-Z0-9]{4,12}$` | `SPRING10` (match), `spring10` (case near-miss), `ABC` (too short), `A@BC` (illegal char) | `Valid`, `Invalid-Format` ×3 |
| enum `{pending,paid,shipped}` | each member, plus `refunded`, plus `PENDING` | `Valid` ×3, `Invalid-Enum`, `Invalid-Case` |
| required | present, absent | `Valid`, `Empty` |
| non-nullable | value, `null` | `Valid`, `Null` |
| unique | a fresh value, an existing value | `Valid`, `Duplicate` |
| foreign key | an existing parent id, a well-formed nonexistent one | `Valid`, `Invalid-Reference` |
| date/time with an ordering rule | a satisfying value, a violating one, the exact boundary instant | `Valid`, `Expired`, `Boundary-Max` |
| free text | ASCII, `Ünïcödé 中文 🎉`, `<script>alert(1)</script>` | `Valid`, `Unicode`, `SpecialChars` |
| **no constraint found** | one ordinary value, one extreme (very long, control characters) | `Valid`, `Unconstrained-Probe` — and cite the gap |

Rules:

- **Inclusivity decides the values.** `≤ 99` gives max=99, above=100. `< 99` gives max=98, above=99. Read Stage 2's interval literally; if it is ambiguous, that is a gap, not a guess.
- **Concrete, never a description.** `SPRING10`, not "a valid promo code". `2025-01-31T23:59:59Z`, not "a past date". An automation runner cannot resolve a description.
- **Relative dates are computed and stated as a rule.** `expiresAt = now − 1 day` with the format given — a hardcoded past date silently becomes a different kind of past over two years.
- **No real personal data, ever.** Synthetic values only, even if the repository contains a seed file full of real-looking records.
- **Injection probes are inert.** A string that *looks* like an attack, asserted to be rejected safely. Never a payload intended to succeed against a real system.

# 7. **Test Data**

One row per **field**, not per dataset — a boundary matrix of six datasets over four fields is twenty-four facts, and no wide table holds two different field sets.

```markdown
| Dataset ID | Test Case ID | Purpose | Field | Value | Value Kind | Source Evidence |
|---|---|---|---|---|---|---|
| TD-CHK-004 | TC-CHK-011 | quantity at upper bound | quantity | 99 | Boundary-Max | src/checkout/dto/checkout.dto.ts:24 |
| TD-CHK-005 | TC-CHK-012 | quantity above upper bound | quantity | 100 | Boundary-Above | src/checkout/dto/checkout.dto.ts:24 |
```

Every row cites the constraint it came from. That citation is what makes the value checkable: a reviewer can open the line and confirm the boundary, and a later reader can tell whether the validator has since moved.

# 8. Parameterized cases

One behaviour across several data points is **one case with several datasets**, not several cases. Point the case's `Test Data` field at the dataset family and give each dataset its own row. Split into separate cases only when the *expected result differs* — `99 → accepted` and `100 → rejected` are two behaviours and therefore two cases.

# 9. **Execution Profile** — and the parallel plan

```markdown
| Test Case ID | Layer | Entry Point | Oracle | Fixtures | Teardown | Isolation | Parallel Group | Deterministic | Est. Runtime | Automation Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| TC-CHK-002 | API | POST /api/checkout | HTTPStatus 422 + error code | seed:promo-winter5-expired | none | read-only | | Yes | 1s | Assert the error code, not the message text |
```

| Column | Values and rules |
|---|---|
| **Layer** | `API` · `UI` · `Contract` · `E2E` — **and nothing else**. These are the layers a tester can drive against a running system (§2.2). `Unit` and `Component` are rejected by Stage 4. Pick the cheapest of the four that observes the behaviour: a DTO validation rule reachable through one endpoint is an `API` case, not an `E2E` one — `E2E` is for a journey that genuinely spans surfaces, and spending 40 seconds to assert one validation message buys nothing. **Depth in the closure does not change the layer, only the entry point:** a rule enforced three hops down is still driven through whichever endpoint or screen reaches it. |
| **Entry Point** | Exactly how the case is addressed — the method+path, route, command, topic. |
| **Oracle** | How pass is decided: `HTTPStatus` · `JSONBody` · `SchemaMatch` · `DBState` · `EventEmitted` · `LogEntry` · `UIAssertion` · `Snapshot`. Combine with `+`. |
| **Fixtures** | Named setup this case needs. Naming them (`seed:promo-spring10`) is what lets a runner share and reuse them. |
| **Teardown** | What must be undone, or `none`. |
| **Isolation** | **Mandatory.** See below. |
| **Parallel Group** | Usually blank — derived from Isolation. Set it only to override with knowledge the isolation level cannot express. |
| **Deterministic** | `Yes`/`No`. `No` requires a reason in Automation Notes (real time, external sandbox, randomness). |
| **Est. Runtime** | A rough order of magnitude. Used to balance shards. |

## 9.1 Isolation — the closed vocabulary

| Value | Means | Scheduling |
|---|---|---|
| `read-only` | Reads only. Changes nothing. | fully parallel |
| `shared-fixture:<name>` | Reads a shared fixture; does not mutate it | parallel within its group |
| `mutates-record:<entity>` | Mutates records it created itself | parallel within its group |
| `exclusive:<resource>` | Needs sole access to a named resource (a payment sandbox, a single test account, a rate-limit budget) | serialized on that resource |
| `global-state` | Changes something process- or environment-wide (a feature flag, system clock, global config) | runs alone |

**Choose the strictest level that is true, not the loosest that seems plausible.** An unrecognised or absent value is scheduled `exclusive` — the safe direction. Guessing "probably parallel-safe" produces an intermittent CI failure, and an intermittent failure costs more than the serial run it avoided.

This one column is what makes the suite runnable in parallel alongside development. Getting it right is worth the extra minute per case.

# 10. **Traceability Matrix**

```markdown
| Test Case ID | Module | Use Case ID | Business Rule ID | Surface ID | Requirement / Source | Source Evidence | Risk | Confidence |
|---|---|---|---|---|---|---|---|---|
| TC-CHK-002 | Checkout | UC-CHK-001 | BR-CHK-005 | SF-API-011 | Expired promotions are rejected | src/promotions/promo.service.ts:61 | High | Confirmed |
```

- **Every case has a row.** No exceptions. Stage 4 warns on any case without one.
- **Module** is mandatory, and it is carried here rather than on the case block because the twelve
  fields are a fixed contract (§3). It is what lets a tester filter the one scope-wide CSV down
  to the area they own; Stage 4 warns on a blank and counts the case as unattributed.
- **Source Evidence** is the line that proves the *expected result*, not merely where the surface lives.
- **Confidence** is inherited from the weakest rule the case rests on. A case built on an `Assumed` rule is `Assumed`, and its Notes say which gap.
- **Risk**: `Low` · `Medium` · `High` · `Critical`, from blast radius — money, data loss, auth, personal data, irreversibility.

# 11. Priority

Priority follows risk; the two are not set independently.

| Priority | For |
|---|---|
| `P1` | Critical/High-risk happy paths, auth boundaries, money, data integrity. The smoke set. |
| `P2` | Core business rules, primary negative cases, main error handling |
| `P3` | Secondary validation, boundary sweep, alternate flows |
| `P4` | Cosmetic, rare configurations, low-risk edges |

**A High or Critical-risk requirement is never left with only a `P4` case.** If risk is High and every case for it is P3+, the design is wrong.

# 12. **Coverage Report**

Two parts. First the per-item status table:

```markdown
| Item ID | Item Type | Status | Test Case IDs | Reason | Source Evidence |
|---|---|---|---|---|---|
| BR-CHK-005 | Business Rule | Covered | TC-CHK-002 | | src/promotions/promo.service.ts:61 |
| BR-CHK-006 | Business Rule | Unknown | | Stacking behaviour could not be determined from source — GAP-007 | src/promotions/promo.service.ts:88 |
```

| Status | Means |
|---|---|
| `Covered` | ≥1 case cites it, and every applicable test type was generated |
| `Partially Covered` | ≥1 case, but an applicable type was left ungenerated for a reason other than `Not Applicable` |
| `Uncovered` | In scope, assessable, **zero** cases, no stated reason. The one status that is always a defect in this stage's own output. |
| `Out-of-Scope` | Explicitly outside this run's scope. Expected to have no cases. |
| `Unknown` | Coverage cannot be judged — the behaviour itself is a gap |
| `Unreachable-Black-Box` | The rule is real and evidenced, but **no** API, UI, job, message or CLI surface reaches it, so no tester-executable case can exist. Cite the `path:line` and say what would have to exist to test it. This is a finding, not a failure of the design stage — it means dead code or a missing surface |

The coverage percentage is computed against `Covered` **only**. The other four are reported beside it, never folded in — otherwise a high percentage hides the partial and unknown items.

Then the prose sections, in this order: **Scope · Execution Closure · Surfaces Covered · Flow
Coverage · Boundary Coverage · Evaluation Grid (surface × test type and flow × section K, with every
`Not Applicable` reason) · Business Rules · Case Counts by Module and Type · Unreachable-Black-Box
Items · Assumption-Derived Cases · Coverage Gaps · Risks · Parallel Plan Summary · Review &
Automation Roll-up · Handoff Checklist.**

**Two denominators, always reported side by side:**

| Denominator | Numerator | Why both |
|---|---|---|
| Surfaces in the inventory | Surfaces with ≥1 case, every applicable type evaluated | Says whether each door was tried |
| **Flows enumerated (§5 K)** | Flows with a K1 case, and the K2–K10 rows evaluated | Says whether the system was used the way it is actually used. 100% of surfaces with 20% of flows is not a covered system, and reporting only the first number hides exactly that. |

**Case Counts by Module** is the per-module breakdown of the one scope-wide suite — the table that
tells a reader whether the scope was covered evenly or whether one module absorbed the whole run.

**Execution Closure** and **Boundary Coverage** are what make a sub-scope percentage meaningful:

| Must state | Because |
|---|---|
| Seed files vs files reached, and the depth walked | A percentage over the seed alone is a percentage of one layer |
| Files in the closure with no case, and why | This is where a sub-scope suite silently stops |
| Per boundary: modes covered / modes possible | the dependency-closure data states the denominator, so this is checkable |
| Impacted callers, and whether each has a regression case | They execute the code without being named by the scope |
| Unresolved edges, restated | Behaviour beyond them is `Unknown`, never `Covered` |
| If the closure was truncated: what that removes from the claim | A truncated closure cannot support a completeness claim |

The **evaluation grid** is the completeness argument. Without it, "we covered everything" is unfalsifiable.

# 13. Self-check before handing off

- [ ] Every case has exactly the twelve fields, in order; no invented labels
- [ ] Every case has exactly one granularity tier tag
- [ ] Every case has a traceability row with `path:line`
- [ ] Every case has an execution-profile row with a valid `Isolation`
- [ ] Every concrete value is concrete — no "a valid X", no "an invalid Y"
- [ ] Every boundary set has all four values, and inclusivity was read from the constraint
- [ ] Every role boundary has its own authorization case; ownership is tested separately from role
- [ ] Every distinct error outcome has an error-handling case asserting status **and** code
- [ ] Every evaluation-grid cell is either generated or `Not Applicable — reason`
- [ ] Every assumption-derived case names its gap in Notes
- [ ] Every `Review` and `Automation` value is literally `Pending`
- [ ] No case duplicates an existing test found in Stage 1 without saying why
- [ ] Every `EXT` boundary has one case per failure mode, or `Not Applicable` **per mode** with a reason
      that is not "hard to arrange" (§5.3)
- [ ] Every boundary case asserts the **caller** behaviour, never the dependency
- [ ] Every case's `Layer` is `API`, `UI`, `E2E` or `Contract` — no `Unit`, no `Component`
- [ ] Every rule enforced below the entry point is driven through an endpoint or screen that
      reaches it, or recorded `Unreachable-Black-Box` with a reason — never given a unit case
- [ ] Every case has a `Module` value on its traceability row
- [ ] The suite is ONE the case set covering the whole scope, cases grouped under
      `## {{Module}}` headings
- [ ] Every impacted caller has a regression case, or a stated reason it needs none
- [ ] Section J evaluated for every surface whose closure spans more than one layer
- [ ] Coverage report states seed vs reached, boundary modes covered / possible, and any truncation
- [ ] Every check in `suite-export` §5 passes, or the failure is recorded as a warning

# 14. Anti-patterns

| Anti-pattern | Why it is wrong |
|---|---|
| "Enter an invalid email" | Not executable. Which invalid email? The runner cannot resolve it. |
| One case per endpoint | An endpoint has a happy path, a boundary set, three role boundaries and four errors. One case tests one of nine things and reports 100%. |
| A boundary case with only max and max+1 | Half the boundary. min−1 and min are where off-by-one lives just as often. |
| Chaining unrelated actions to "save time" | When it fails you do not know which behaviour broke. |
| An E2E case replacing atomic cases | E2E is additive. Replacing atomic coverage trades diagnosability for a green tick. |
| Verification inside a step | Splits the pass/fail decision across two fields; the runner asserts the wrong thing. |
| Restating the bug as the expected result | A regression test asserts the CORRECTED behaviour. |
| Inventing a config value the code does not define | Tests a state that cannot exist and fails forever. |
| Marking everything `read-only` to get parallelism | Buys speed with intermittent failures, which cost far more. |
| Writing `Review: Approved` | The suite has then reviewed itself, which is the one thing that column exists to prevent. |
| "Simulate a failure from the payment provider" | Names no failure, no injection point and no expected result. Nobody can execute it. Name the mode, the `path:line`, and what the caller does. |
| One case per external dependency | A payment gateway has six failure modes with six different observable outcomes. One case tests one of them and reports the dependency as covered. |
| Asserting the dependency instead of the caller | "The gateway returns 402" is a precondition. The expected result is the status the caller returns and whether the order row exists. |
| Recording a mode `Not Applicable` because no sandbox exists | An execution problem, not an inapplicable test. It belongs in Automation Notes; recording it as N/A converts a missing test into a false claim of coverage. |
| Driving a deep rule through the entry point when the unit is reachable | Buys nothing, costs seconds per case, and points the failure at the wrong layer when it breaks. |
| Stubbing an in-repo callee that could have been executed | Discards every rule that callee enforces, which the closure already proved is on the path. |
| Asserting the sensible behaviour where the code has none | Fails on unchanged code, so it gets deleted. Assert what happens and note the gap. |
| Hand-editing the generated CSV | It is generated. The edit is discarded on the next run — silently. Fix the design, then re-run. |
| Writing a `Unit` or `Component` case | The tester has no harness and will skip it — and a skipped row still counts as coverage, so the rule is reported tested when nobody has ever run it. |
| Splitting the scope into one CSV per module | The tester wanted one file they can filter. Six files means every total is per-file and the scope-wide number nobody computes is the only one that answers the question. |
| Leaving `Module` blank on a traceability row | The case is unattributed: absent from every per-module total while still inflating the overall one. |
| A suite of atomic cases with no journeys | Every door was tried and nobody ever walked through the building. Section K is not a garnish. |
| One E2E case with branches for each variation | A branch that is never taken is coverage that does not exist. One case per variation. |
| Marking a deep rule `Not Applicable` because no endpoint obviously reaches it | Look again through the closure. If genuinely nothing reaches it, that is `Unreachable-Black-Box` — a finding worth reporting, not a cell to close. |
