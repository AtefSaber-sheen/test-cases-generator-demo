---
name: behavior-spec
description: Stage 2 of test generation from a codebase alone. Reads the source behind each inventoried surface - and behind everything it transitively calls - then extracts what the system actually DOES: use cases, business rules, data contracts, state machines, authorization boundaries, error behaviour and config dependence, each with `path:line` evidence and an explicit confidence. Produces the specification a codebase never had, without running anything. Use after codebase-recon, or when a module behaviour must be written down before tests can be designed.
inputs:
  - { name: surface_inventory, type: in_context, required: true, description: Stage 1 inventory - the coverage denominator. }
  - { name: codebase_map, type: in_context, required: true, description: Stage 1 map - names the validation library, ORM and auth mechanism, which decide where rules live. }
  - { name: dependency_closure, type: in_context, required: false, description: "Stage 1 closure - files each surface transitively executes, plus unreadable dependencies and their failure modes. Required in practice below full-repo; without it this stage stops one level down." }
  - { name: repository, type: directory_path, required: true, description: The source tree, read-only. }
outputs:
  - { name: use_case_catalog, type: in_context, description: Actor, trigger, main/alternate/exception flows, postconditions. HELD IN CONTEXT. }
  - { name: business_rules, type: in_context, description: One row per enforceable rule as a testable proposition. HELD IN CONTEXT. }
  - { name: data_contracts, type: in_context, description: Field types, requiredness, constraints, defaults, enums - the source of every boundary and invalid value Stage 3 uses. HELD IN CONTEXT. }
  - { name: gaps, type: in_context, description: Appended to Stage 1 gaps, never replacing them. HELD IN CONTEXT. }
dependencies:
  - codebase-recon (upstream skill)
---

> Stage 2 of 4 — `codebase-recon` → **`behavior-spec`** → `test-design-from-code` → `suite-export`. Adds `Surface → Use Case / Business Rule / Data Contract`: Stage 1 said what exists, this says what it does and proves each claim with a line of code.

## The rule that outranks every other

**Never state a behaviour you have not read.** The failure mode here is not missing a rule, it is inventing a plausible one — writing "email must be a valid address" because a field is called `email` when the code validates nothing. That test fails against correct code and costs the suite its credibility.
| Confidence | Means | Backing required |
|---|---|---|
| `Confirmed` | The code says it; you read the line | `path:line` at the enforcing code |
| `Inferred` | Follows necessarily from an evidenced library/framework convention | `path:line` **plus** the named convention (`z.string().email()` rejects non-RFC5322 input) |
| `Assumed` | Neither | closest `path:line` **plus** a matching `GAP-` row |

An `Assumed` row is legitimate; an `Assumed` row labelled `Confirmed` is the worst output this pipeline can produce. A field name is never evidence of its constraint. A comment or docstring is intent, not behaviour — when they disagree the code wins and the disagreement is a finding. A test file shows what someone believed; cite product code for facts. "It probably 404s" is not a rule: find the line or write the gap.

## Where the rules live

**Read Dependency Closure first** — it names every file the surface executes and at what depth. That is the reading list for step 5, and using it is what stops this stage one level down.

Read outward from the entry point, cheapest and densest first: **1** schema/DTO/validator (requiredness, types, lengths, ranges, patterns, enums, defaults - the whole boundary matrix) · **2** guard/middleware/decorator chain (authentication, roles, ownership, rate limits) · **3** handler body branch by branch (every conditional is a rule, every early return an exception flow) · **4** every throw/raise/error return (exception flows and their observable status, code, message) · **5** every in-repo callee transitively to the bottom of the closure, not one level (the business rules proper: pricing, eligibility, state transitions, invariants) · **6** each `EXT` boundary reached (the failure modes the caller must handle) · **7** persistence layer and migrations (uniqueness, nullability, foreign keys, cascades, DB-applied defaults) · **8** config and flag reads on the path (each documented state is a separate expected behaviour) · **9** emitted events, mail, files, cache writes (postconditions beyond the response, and the isolation Stage 3 needs).

**Validators across ecosystems** — extract the constraint, never the syntax: Zod/Yup/Joi/AJV schema objects · class-validator DTO decorators · Pydantic/Marshmallow `Field(gt=0, le=99)` · Bean Validation `@Size(min=1,max=99)` · FluentValidation/DataAnnotations · go-playground struct tags · Rails/Django model validations · hand-rolled `if` guards (the guard IS the constraint). **None found** → record `None enforced in code` and raise a gap: that absence is a finding and often a bug.

**Conflicts.** A DTO saying `max 120` over a `varchar(100)` column is a conflict: record both, cite both, raise a gap. The effective limit is the tightest on the whole path (100), and the 20-character gap is where the defect lives.

**Authorization** — per surface, answer and cite: is authentication required and by which mechanism · which roles/scopes pass · is there an **ownership** check beyond the role (can role X touch another user's record) · what is the observable failure outcome (401 vs 403 vs 404 vs a silent empty list). The ownership question is the one that gets skipped and the one that finds real vulnerabilities; the last decides whether a negative case asserts the right thing.

**State machines** — recover the transition table: which values exist (enum or DB constraint), which transitions the code permits, which it rejects, what triggers each. Record the legal set explicitly; Stage 3 generates one case per *illegal* transition and can only do that if the legal set is written down.

## Depth: down the closure and out to boundaries

### Down the closure

A rule enforced three calls below the entry point runs on **the same request** — same inputs rejected, same status code, same breakage. It belongs to the surface that reaches it. Record rules at the depth they are enforced, citing the enforcing file: depth 0 entry point (`Validation`, `Authorization`) · 1 service (`Calculation`, `StateTransition`, `Temporal`, eligibility) · 2 repository/gateway (`Uniqueness`, `Referential`, `Concurrency`) · 3+ shared utilities (`Calculation`, `Idempotency`, `Ordering`).

A rule enforced **twice** (controller and again in the service) is two rows: removing either changes behaviour and only a test at each point notices. **Attribute every rule to every surface that reaches it** — a shared validator used by four surfaces cites all four, which is what makes the blast radius visible.

Read to the bottom, with two recorded exceptions: a pure utility with no branch and no I/O (a wrapper around `Math.round` is not a business rule), and an unreadable dependency (an `EXT` contract, below). If the closure was truncated, say so per surface — rules below it are **Unknown**, not absent.

### An unreadable dependency

The dependency cannot be read, but the interesting behaviour is not in it — **it is in the caller**, which is in the repository. Read the call site and its error handling and record: what the caller does with success (the main flow) · whether the call is wrapped at all · per failure mode, what is observable (status, code, retry, fallback, partial write) · retries, timeouts, circuit breakers, idempotency keys · whether failure leaves state half-written (usually the highest-risk case on the surface).

Failure modes come from the closure data — each boundary carries the modes its **role** can produce. Do not invent them and do not collapse them into "the dependency fails". The mode is an input; the caller response is a claim about code: an explicit handler is `Confirmed`, a framework-wide handler is `Inferred` naming the convention, and **no handling at all** is `Confirmed` (the absence is read) plus a gap. That last is the valuable one — usually a real defect, invisible to any run that stubbed the dependency. Record what the code does, not what it ought to: if a declined card yields a 500 and a leaked stack trace, that is the behaviour, and the test asserting it is what gets it fixed.

## Output schemas

**Use Case Catalog** — a use case is one complete unit of value an actor obtains through one or more surfaces (`Place an order`), not one route (`POST /orders` is the surface it acts through).

`| Use Case ID | Module | Title | Actor | Surface ID(s) | Trigger | Preconditions | Main Flow | Alternate Flows | Exception Flows | Postconditions | Confidence | Source Evidence |`

Module is mandatory (the label the tester filters by). Actor is the role, or `System` for jobs and consumers. Main Flow is one or two sentences — Stage 3 writes steps. Alternate Flows are successful paths that differ; **Exception Flows carry the observable outcome of each failure** and are the direct input to Stage 3 negative cases, so an incomplete cell silently deletes tests. Postconditions are what a test asserts beyond the response body. Every surface appears in a use case or has a gap saying why not.

**Mark multi-surface use cases as flows** — Stage 3 section K enumerates journeys only from these, so a catalogue of single-surface rows silently removes every journey downstream. Where a journey spans several use cases (cart → checkout → confirmation), give it its own `UC-` whose Main Flow names the sequence.

**Business Rules** — a proposition a test can make false.

`| Rule ID | Module | Statement | Type | Surface ID(s) | Enforcement Point | Observable Via | Failure Mode | Configurable | Confidence | Source Evidence |`

Statement: one falsifiable proposition, never "handles promotions correctly" — if you cannot describe an input that makes it false, it is not a rule. Type: `Validation`/`Calculation`/`Authorization`/`StateTransition`/`Temporal`/`Uniqueness`/`Referential`/`RateLimit`/`Idempotency`/`Ordering`/`Concurrency` (it steers Stage 3 test-type selection). Enforcement Point: where it is checked. **Observable Via** exists because Stage 3 may only write cases a tester can run against the running system: name the addressable surface and what they would see, tracing up the call graph from a deep rule; when nothing reaches it write `Unreachable — no surface reaches this rule`, a real finding rather than an invented unit test. Failure Mode: exactly what is observable when violated — without it no negative test can be written. Configurable: `No` or the key that changes it (a flag that disables the rule is a second behaviour needing its own coverage). **Split compound rules** — "rejects expired or already-used codes" is two rules with two failure modes.

**Data Contracts** — the ammunition for Stage 3 negative testing; its completeness decides how many real boundary cases exist.

`| Contract ID | Name | Surface ID(s) | Field | Type | Required | Constraints | Default | Enum Values | Nullable | Confidence | Source Evidence |`

Constraints as a readable interval or pattern with **inclusivity explicit** — `1 ≤ n ≤ 99` is testable, "max 99" leaves the tester guessing whether 99 passes, and that is the commonest cause of a wrong boundary test. Required and Nullable are different questions (required-but-nullable produces a different negative case each). Record the effective constraint plus the disagreement when layers differ. Include persisted contracts, not only request bodies: DB uniqueness and foreign keys generate conflict and referential tests nothing else will.

**Gaps** — append to Stage 1 table, same marker. Raise one whenever: a field has no discoverable validation · two layers conflict · a status code or error shape cannot be determined · a config branch's non-default behaviour is unread · authorization cannot be established · correctness depends on data the source does not contain.

## Workflow, coverage and self-check

Load Stage 1 artifacts (absent inventory or evidence-free rows → stop and say so; this stage cannot invent its own scope) → order surfaces by risk, money/auth/personal-data/destructive first so a cut-short run has done the important half → per surface read the sources above, including every in-repo callee and `EXT` boundary, writing rows as you go rather than batching (a rule remembered is a rule mis-stated) → assemble use cases by the value delivered → sweep cross-cutting behaviour no single surface owns (global error handlers, response envelopes, pagination defaults, rate limits, CORS, audit logging, i18n) → self-check → report counts, confidence distribution and gaps raised.

### Coverage and self-check

Every surface is cited by ≥1 use case or has a gap — there is no third option. Every use case has ≥1 exception flow or a stated reason it cannot fail. Every input field appears in Data Contracts, unvalidated ones included. Report the confidence distribution: a spec 60% `Assumed` is a research report and downstream must be told. Report files read / files reached; every closure file is read or explicitly excluded with a reason. Every `EXT` boundary has one rule per failure mode, unhandled modes recorded as unhandled.

Before handing off: every row has `path:line` and Confidence · every `Assumed` row has a `GAP-` · no statement contains "correctly", "properly", "as expected" or "handles" · every constraint states inclusivity · every rule has a Failure Mode or is a `Calculation` · compound rules split, enums and transitions enumerated · layer conflicts recorded not silently resolved · effective constraints reflect the tightest limit on the path · rules enforced at two depths are two rows · behaviour below a truncation is `Unknown` · every row carries its `Module` · every rule has an `Observable Via` or is marked unreachable · multi-surface use cases identified as flows.

## Handoff to `test-design-from-code`

Use cases with main/alternate/exception flows → positive, alternate and error cases · rules with failure modes → one direct case each, positive and negative · contracts with explicit intervals and enums → the boundary, invalid-type, empty and enum matrix · authorization per surface → one case per role boundary plus ownership · transition tables → one case per legal and illegal transition · config dependence → one case per documented state · postconditions → assertions beyond the response, and the isolation level · `EXT` rules → one resilience case per mode per calling surface · deep rules with `Observable Via` → cases driven through the reaching endpoint, never a unit case · flows → the section K journeys · `Module` on every row → the column that makes one CSV filterable · gaps → cases marked assumption-derived and coverage recorded `Unknown`.
