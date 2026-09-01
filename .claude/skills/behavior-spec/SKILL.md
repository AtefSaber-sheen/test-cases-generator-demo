---
name: behavior-spec
description: Stage 2 of test generation from a codebase alone. Reads the source behind each inventoried surface — and behind everything that surface transitively calls — then extracts what the system actually DOES: use cases, business rules, data contracts, state machines, authorization boundaries, error behaviour and configuration dependence — each with `path:line` evidence and an explicit confidence. Produces the specification a codebase never had, without running anything. Use after `codebase-recon`, or when a module's behaviour must be written down before tests can be designed.
inputs:
  - name: surface_inventory
    type: in_context
    required: true
    description: The Stage 1 surface inventory - the coverage denominator. Carried in context, not read from disk.
  - name: codebase_map
    type: in_context
    required: true
    description: The Stage 1 codebase map - names the validation library, ORM and authorization mechanism, which decide where the rules live.
  - name: dependency_closure
    type: in_context
    required: false
    description: The Stage 1 dependency closure - the files each surface transitively executes, and the unreadable dependencies it reaches with their failure modes. Required in practice for any scope narrower than the whole repository: without it this stage reads one level down and records the callees as black boxes.
  - name: repository
    type: directory_path
    required: true
    description: The source tree, read-only.
outputs:
  - name: use_case_catalog
    type: in_context
    description: One row per use case - actor, trigger, main flow, alternate and exception flows, postconditions. HELD IN CONTEXT, not written to disk. Rendered into the Stage 4 report.
  - name: business_rules
    type: in_context
    description: One row per enforceable rule, stated as a testable proposition. HELD IN CONTEXT. Rendered into the Stage 4 report.
  - name: data_contracts
    type: in_context
    description: Field-level types, requiredness, constraints, defaults and enums - the source of every boundary and invalid value Stage 3 will use. HELD IN CONTEXT. Rendered into the Stage 4 report.
  - name: gaps
    type: in_context
    description: Added to Stage 1's gaps, not replacing them. Stage 2 raises the questions source could not settle about behaviour. HELD IN CONTEXT. Rendered into the Stage 4 report's Gaps and assumptions section.
dependencies:
  - codebase-recon (upstream skill)
---

> **Pipeline position:** Stage 2 of 4 — `codebase-recon` → **`behavior-spec`** → `test-design-from-code` → `suite-export`.
> **What this stage adds to the chain:** `Surface → Use Case / Business Rule / Data Contract`. Stage 1 said *what exists*; this says *what it does*, and proves each claim with a line of code.

# 1. Purpose

Most codebases have no specification, or one that stopped being true a year ago. This stage writes the specification **from the code, for the code that is actually there** — so that Stage 3 designs tests against behaviour rather than against a wish.

The output is not documentation for its own sake. Every row exists because it will produce test cases, and its columns are exactly what a test needs: who acts, what triggers it, what must hold afterwards, what the limits are, and what happens when they are broken.

# 2. The rule that outranks every other rule

**Never state a behaviour you have not read.**

The failure mode of this stage is not missing a rule. It is *inventing a plausible one* — writing "the email field must be a valid email address" because a field is called `email`, when the code validates nothing at all. That produces a test that fails against correct code, which costs a developer an afternoon and costs the whole suite its credibility.

So every row carries a **Confidence**:

| Value | Means | Required backing |
|---|---|---|
| `Confirmed` | The code says it. You read the line. | `path:line` pointing at the enforcing code |
| `Inferred` | Follows necessarily from an evidenced framework or library convention | `path:line` **plus** the named convention (e.g. "`z.string().email()` rejects non-RFC5322 input") |
| `Assumed` | Neither of the above | `path:line` for the closest evidence **plus** a matching `GAP-` row. Stage 3 marks every case derived from it. |

An `Assumed` row is legitimate and useful. An `Assumed` row *labelled* `Confirmed` is the single worst output this pipeline can produce.

Corollaries:

- A field's **name** is never evidence of its **constraint**.
- A comment or a docstring is evidence of *intent*, not behaviour. When code and comment disagree, the code wins and the disagreement is a finding worth recording.
- A test file shows what someone believed. Read it for hints; cite product code for facts.
- "It probably 404s" is not a rule. Either find the line, or write the gap.

# 3. Where the rules actually live

Work surface by surface. For each, read outward from the entry point in this order — the sequence is
chosen so the cheapest, densest sources come first.

**Read **Dependency Closure** first.** Stage 1 already walked the graph: it names every file the
surface executes, at what depth, and every unreadable dependency it reaches. That is the reading
list for step 5, and using it is what stops this stage stopping one level down.

| # | Read | What it yields |
|---|---|---|
| 1 | **The schema / DTO / validator** for its input | requiredness, types, lengths, ranges, patterns, enums, defaults — the entire boundary matrix, stated declaratively |
| 2 | **The guard / middleware / decorator chain** | authentication requirement, roles, ownership checks, rate limits |
| 3 | **The handler body, branch by branch** | every conditional is a rule; every early return is an exception flow |
| 4 | **Every `throw` / `raise` / error return** | the exception flows and their observable outcomes (status, code, message) |
| 5 | **Every in-repo callee, transitively** — the service it calls, what that calls, to the bottom of the closure | the business rules proper: pricing, eligibility, state transitions, invariants. **Not one level.** See §3.4 |
| 5b | **Each unreadable dependency it reaches** (`EXT`) | the failure modes the caller must handle, and what it does with each. See §3.5 |
| 6 | **The persistence layer and migrations** | uniqueness, nullability, foreign keys, cascade behaviour, defaults the DB applies |
| 7 | **Config and feature-flag reads on the path** | behaviour that differs by environment — each documented state is a separate expected behaviour |
| 8 | **Emitted events, mail, files, cache writes** | postconditions beyond the response, and the isolation Stage 3 will need |

## 3.1 Reading validators across ecosystems

The constraint vocabulary is the same everywhere; only the syntax changes. Extract the **constraint**, never the syntax.

| Ecosystem | Where to look | Reads as |
|---|---|---|
| Zod / Yup / Joi / AJV | schema object | `.min(1).max(99)` → range 1–99 inclusive |
| class-validator | DTO decorators | `@IsEmail() @MaxLength(120)` |
| Pydantic / Marshmallow | model fields | `Field(gt=0, le=99)`, `constr(max_length=120)` |
| Bean Validation | entity/DTO annotations | `@NotBlank @Size(min=1,max=99)` |
| FluentValidation / DataAnnotations | validator class / attributes | `RuleFor(x => x.Qty).InclusiveBetween(1,99)` |
| go-playground/validator | struct tags | `validate:"required,gte=1,lte=99"` |
| Rails / Django | model validations, form fields | `validates :qty, inclusion: { in: 1..99 }` |
| Hand-rolled | `if` guards in the handler | the guard IS the constraint — record it the same way |
| **None found** | — | record the field with constraint `None enforced in code` and raise a gap. This is a finding, and often a bug. |

Two constraints for the same field in different places (a DTO says `max 120`, the DB column says `varchar(100)`) is a **conflict**. Record both, cite both, and raise a gap: the effective limit is 100 and the difference is exactly where a defect lives.

## 3.2 Reading authorization

For every surface, answer four questions and cite each:

1. Is authentication required? Which mechanism?
2. Which roles/scopes/permissions pass?
3. Is there an **ownership** check beyond the role (can role X touch *another user's* record)?
4. What is the observable outcome of failure — 401 vs 403 vs 404 vs silent empty list?

Question 3 is the one that gets skipped, and it is the one that finds real vulnerabilities. Question 4 decides whether a negative case asserts the right thing.

## 3.3 Reading state machines

Where an entity has a `status`/`state` field, recover the **transition table**: which values exist (from the enum or the DB constraint), which transitions the code permits, which it rejects, and what triggers each. Record the permitted set explicitly — Stage 3 generates one test per *illegal* transition, and it can only do that if the legal set is written down.

## 3.4 Reading down the closure

A rule enforced three calls below the entry point is enforced on **the same request**. It rejects
the same inputs, produces the same status code, and breaks the same way. It is not a different
system, and it is not somebody else's test — it belongs to the surface that reaches it.

So for each surface, walk its subtree of the closure and record rules **at the depth they are
enforced**, citing the file that enforces them:

| Depth | Typically holds | Rule types found there |
|---|---|---|
| 0 — entry point | request shape, auth, orchestration | `Validation`, `Authorization` |
| 1 — service | the domain logic | `Calculation`, `StateTransition`, `Temporal`, eligibility |
| 2 — repository / gateway | query shape, mapping, transaction boundary | `Uniqueness`, `Referential`, `Concurrency` |
| 3+ — shared utilities | rounding, formatting, ID generation, clock | `Calculation`, `Idempotency`, `Ordering` |

Two rules that matter and are lost by stopping at depth 1:

- **The effective constraint is the tightest one on the whole path.** A DTO allowing 120 characters
  in front of a column holding 100 has an effective limit of 100, and the 20-character gap is where
  the defect lives. §3.1 already says record both and raise a gap — the closure is how you find the
  second one.
- **A rule can be enforced twice.** The same check in a controller and again in a service is two
  enforcement points and needs two rows, because removing either one changes behaviour and only a
  test at each point notices.

**Attribute every rule to the surface(s) that reach it.** A shared validator used by four surfaces
cites all four in `Surface ID(s)`. That is what makes the blast radius of changing it visible.

### Where to stop

Read to the bottom of the closure, with two exceptions that are recorded rather than assumed:

| Stop at | Because | Record as |
|---|---|---|
| A pure utility with no branch and no I/O | It has no rule to state — a wrapper around `Math.round` is not a business rule | nothing, unless a calculation cites it |
| An unreadable dependency | There is no source to read | an `EXT` contract per §3.5 |

If the closure was truncated (Stage 1 exit 2), say so per surface: the rules below the truncation
are **unknown**, not **absent**, and a coverage report must show them as `Unknown`.


## 3.5 Reading an unreadable dependency

When the closure reaches something whose source is not present — a payment SDK, an HTTP client, a
database driver — the dependency cannot be read. That is not a reason to record nothing, because
the interesting behaviour is not in the dependency. **It is in the caller.**

The caller is in the repository. What it does when the dependency succeeds, and what it does for
each way the dependency can fail, is fully readable and fully testable. So for each `EXT` boundary,
read the **call site and its surrounding error handling** and record:

| Question | Answer becomes |
|---|---|
| What does the caller do with a successful result? | the main flow of the use case |
| Is the call wrapped in `try`/`catch`, `.catch()`, `rescue`, an error return? | whether failure is handled at all |
| For each failure mode, what is observable — status, error code, retry, fallback, partial write? | one exception flow, and one `ErrorHandling` rule with a stated Failure Mode |
| Is there a retry, a timeout, a circuit breaker, an idempotency key? | `Resilience` / `Idempotency` rules |
| Does a failure leave state half-written? | a postcondition, and usually the highest-risk case on the surface |

The failure modes to work through come from the dependency-closure data — each boundary carries the modes its
**role** can produce (a payment gateway declines; a database deadlocks and violates constraints; an
HTTP client times out and returns 5xx). Do not invent them, and do not collapse them into
"the dependency fails".

### The rule that keeps this honest

The failure mode is an **input**. The caller response is a **claim about code**, and it obeys the
same evidence rules as everything else in this stage:

| If the source shows | Record | Confidence |
|---|---|---|
| An explicit handler mapping the failure to an outcome | that outcome, citing the handler line | `Confirmed` |
| A framework-level handler that catches everything | the documented framework behaviour, naming the convention | `Inferred` |
| **No handling at all** | that the failure propagates unhandled — and raise a gap | `Confirmed` (the absence is read) |

That third row is the valuable one. An unhandled boundary failure is usually a real defect, and it
is invisible to any run that treated the dependency as a black box. Record what the code does, not
what it ought to do: if a declined card produces a 500 and a leaked stack trace, **that** is the
behaviour, and the test asserting it is what gets it fixed.


# 4. Output schemas

## 4.1 **Use Case Catalog**

A **use case** is one complete unit of value a specific actor obtains through one or more surfaces. Not one route — a route is a surface. `Place an order` is a use case; `POST /orders` is the surface it acts through.

```markdown
| Use Case ID | Module | Title | Actor | Surface ID(s) | Trigger | Preconditions | Main Flow | Alternate Flows | Exception Flows | Postconditions | Confidence | Source Evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| UC-CHK-001 | Checkout | Apply a promotion at checkout | Authenticated customer | SF-API-011 | Customer submits a cart with a promo code | Cart has at least one item; promotion exists and is active | Code is validated, discount computed as a percentage of subtotal, order created with the reduced total | Code omitted → order created at full price | Code expired → 422; code already used by this customer → 409; cart empty → 422 | An order row exists with `discountApplied` set and stock decremented | Confirmed | src/checkout/checkout.controller.ts:73, src/promotions/promo.service.ts:44 |
```

- **Module** — carried from the surface inventory. One suite covers the whole scope, so this is the label a tester filters by; it must be present on every row.
- **Actor** — the role that can perform it, from §3.2. `System` for jobs and consumers.
- **Main Flow** — the successful path, in one or two sentences. Not step-by-step; Stage 3 writes steps.
- **Alternate Flows** — successful paths that differ (optional input omitted, a different role, a flag on).
- **Exception Flows** — the failure paths, **with the observable outcome of each**. This column is the direct input to Stage 3's negative and error-handling cases, so an incomplete cell silently deletes tests.
- **Postconditions** — what is true afterwards: rows written, events published, state changed. This is what a test asserts beyond the response body.

Every use case cites at least one surface, and every non-`AUTH`/`CFG` surface appears in at least one use case — or has a row in **Gaps** saying why not.

**Mark the multi-surface ones.** A use case whose `Surface ID(s)` names more than one surface, or whose Main Flow crosses UI and API, is a **flow** — the unit Stage 3's section K enumerates its end-to-end journeys from. Stage 3 cannot invent flows the spec never identified, so a catalogue that records only single-surface use cases silently removes every journey case downstream. Where a real journey spans several use cases (add to cart → checkout → confirmation), record it as its own `UC-` whose Main Flow names the sequence, rather than leaving it implicit in three separate rows.

## 4.2 **Business Rules**

A **business rule** is a proposition that is either upheld or violated. State it so that a test can make it false.

```markdown
| Rule ID | Module | Statement | Type | Surface ID(s) | Enforcement Point | Observable Via | Failure Mode | Configurable | Confidence | Source Evidence |
|---|---|---|---|---|---|---|---|---|---|---|
| BR-CHK-005 | Checkout | A promotion whose `expiresAt` is in the past is rejected | Temporal | SF-API-011 | `PromoService.validate` before discount calculation | `POST /api/checkout` → 422 body | HTTP 422, error code `PROMO_EXPIRED`, total unchanged | No | Confirmed | src/promotions/promo.service.ts:61 |
| BR-CHK-004 | Checkout | Discount equals `subtotal × promotion.percentage`, rounded half-up to 2 decimals | Calculation | SF-API-011 | `PromoService.apply` | `POST /api/checkout` → `discount` in the response body | — | No | Confirmed | src/promotions/promo.service.ts:44-52 |
```

- **Statement** — one falsifiable proposition. Not "handles promotions correctly". If you cannot describe an input that makes it false, it is not a rule.
- **Type** — `Validation` · `Calculation` · `Authorization` · `StateTransition` · `Temporal` · `Uniqueness` · `Referential` · `RateLimit` · `Idempotency` · `Ordering` · `Concurrency`. The type steers Stage 3's test-type selection.
- **Enforcement Point** — *where* it is checked. Two rules enforced in two places need two tests even when they read alike.
- **Observable Via** — **the reason this column exists is that Stage 3 may only write cases a tester can run against the running system.** Name the surface a tester can address and the thing they would see: `POST /api/checkout` → the status, the body field, the persisted row, the emitted event. A rule enforced deep in a service is still observable this way — trace up the call graph to the entry point that reaches it. When **nothing** reaches it, write `Unreachable — no surface reaches this rule`: that is a real finding (dead code, or a surface that was never built) and Stage 3 records it rather than inventing a unit test for it.
- **Failure Mode** — exactly what is observable when violated. A rule with no stated failure mode cannot have a negative test written for it.
- **Configurable** — `No`, or the config key that changes it. If a flag turns the rule off, that is a second behaviour and it needs its own coverage.

**Split compound rules.** "Rejects expired or already-used codes" is two rules with two failure modes. One row per rule.

## 4.3 **Data Contracts**

This table is the ammunition for the whole negative-testing engine in Stage 3. Its completeness determines how many real boundary cases exist.

```markdown
| Contract ID | Name | Surface ID(s) | Field | Type | Required | Constraints | Default | Enum Values | Nullable | Confidence | Source Evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|
| DC-004 | CheckoutRequest | SF-API-011 | promoCode | string | No | `^[A-Z0-9]{4,12}$`; trimmed before validation | — | — | Yes | Confirmed | src/checkout/dto/checkout.dto.ts:18 |
| DC-004 | CheckoutRequest | SF-API-011 | quantity | integer | Yes | 1 ≤ n ≤ 99 | 1 | — | No | Confirmed | src/checkout/dto/checkout.dto.ts:24 |
| DC-007 | Order (persisted) | SF-API-011 | status | enum | Yes | transitions: pending→paid→shipped; pending→cancelled | pending | pending, paid, shipped, cancelled | No | Confirmed | prisma/schema.prisma:31, src/orders/order.service.ts:88 |
```

- **Constraints** — written as a readable interval or pattern, with **inclusivity explicit**. `1 ≤ n ≤ 99` is testable; "max 99" leaves the tester guessing whether 99 passes. Getting this wrong is the commonest cause of a wrong boundary test.
- **Required** vs **Nullable** are different questions: a field may be required-but-nullable (must be present, may be `null`) and each produces a different negative case.
- Record the **effective** constraint when several layers disagree, and record the disagreement (§3.1).
- Include persisted contracts, not only request bodies: DB-level uniqueness and foreign keys generate conflict and referential-integrity tests nothing else will.

## 4.4 Gaps

Append to Stage 1's **Gaps**, same table and marker. Raise a gap whenever:

- a field has no discoverable validation
- two layers state conflicting constraints
- a status code or error shape cannot be determined
- a config/flag branch exists whose non-default value's behaviour is unread
- authorization for a surface cannot be established
- a rule's correctness depends on data the source does not contain (a lookup table, a remote policy)

# 5. Workflow

1. **Load Stage 1's artifacts.** If **Surface Inventory** is absent or has rows without evidence, stop and say so — this stage cannot invent its own scope. Load **Dependency Closure** and the dependency-closure data too: they name the files behind each surface and the boundary failure modes, and without them step 3 stops one level down.
2. **Order the surfaces by risk.** Money, auth, personal data, destructive operations first. If the run is cut short, the important half is done.
3. **For each surface, read the sources in §3** — including every in-repo callee in its closure subtree (§3.4) and every `EXT` boundary it reaches (§3.5). Write rows as you go; do not batch the writing to the end, because a rule remembered is a rule mis-stated.
4. **Assemble use cases.** Group surfaces by the value they deliver. A use case spanning several surfaces cites all of them.
5. **Sweep for cross-cutting behaviour** that no single surface owns: global error handlers, response envelopes, pagination defaults, rate limits, CORS, audit logging, i18n. Each becomes a rule applying to many surfaces.
6. **Self-check against §7.**
7. **Report** counts, confidence distribution, and gaps raised.

# 6. Coverage rules

- Every surface from Stage 1 is either cited by ≥1 use case, or has a gap explaining why not. There is no third option.
- Every use case has ≥1 exception flow, or a stated reason it cannot fail.
- Every input field of every surface appears in **Data Contracts**. A field with no constraint is recorded with `None enforced in code` — omitting it loses the fact that it is unvalidated, which is precisely the interesting fact.
- Report the confidence distribution (`Confirmed` / `Inferred` / `Assumed`) per artifact. A spec that is 60% `Assumed` is a research report, not a specification, and downstream must be told.
- **Every file in the closure has been read, or is explicitly excluded with a reason.** Report
  files read / files reached. A spec covering the seed and none of its callees is a spec for one
  layer of a multi-layer execution path, and it must not be presented as the behaviour of the
  surface.
- **Every `EXT` boundary has one rule per failure mode**, or a stated reason that mode cannot occur
  here. An unhandled mode is recorded as unhandled — that is the finding, not an omission.
- **Rules are attributed to every surface that reaches them.** A shared validator four surfaces
  deep cites all four.

# 7. Self-check before handing off

- [ ] Every row has `path:line` evidence and a Confidence value
- [ ] Every `Assumed` row has a matching `GAP-` row
- [ ] No rule statement contains "correctly", "properly", "as expected", or "handles"
- [ ] Every constraint states inclusivity explicitly
- [ ] Every business rule has a Failure Mode, or is a `Calculation` type
- [ ] Every surface is covered by a use case or a gap
- [ ] Compound rules are split; enum and transition sets are enumerated
- [ ] Conflicts between layers are recorded, not silently resolved
- [ ] Confidence distribution reported
- [ ] Every in-repo file the surface reaches has been read to the bottom of the closure, or
      excluded with a reason (§3.4)
- [ ] Every `EXT` boundary has a rule per failure mode, including the modes the code does **not**
      handle (§3.5)
- [ ] Effective constraints reflect the tightest limit on the whole path, not only the entry DTO
- [ ] Rules enforced at two depths are two rows, not one
- [ ] Behaviour below a truncated closure is recorded as `Unknown`, never as absent
- [ ] Every row carries its `Module`, so the one scope-wide suite can be filtered by area
- [ ] Every business rule has an `Observable Via` naming a surface a tester can address, or is
      explicitly marked `Unreachable — no surface reaches this rule`
- [ ] Multi-surface use cases are identified as flows, and a journey spanning several use cases has
      its own `UC-` row — Stage 3 cannot enumerate journeys the catalogue never recorded

# 8. Handoff contract to `test-design-from-code`

Stage 3 needs, and will refuse to proceed without:

| From this stage | Used to generate |
|---|---|
| Use cases with main/alternate/exception flows | positive, alternate-path and error-handling cases |
| Business rules with failure modes | one direct case per rule, positive and negative |
| Data contracts with explicit intervals and enums | the boundary, invalid-type, empty and enum-violation matrix |
| Authorization per surface (roles + ownership + failure outcome) | one case per role boundary, plus the ownership case |
| State transition tables | one case per legal transition and per illegal transition |
| Config/flag dependence | one case per documented state |
| Postconditions and side effects | the assertions beyond the response, and the isolation level |
| `EXT` boundary rules, one per failure mode | one resilience/error case per mode, per calling surface |
| Rules found at depth, with their `Observable Via` entry point | cases driven through the endpoint or screen that reaches them — never a unit case, which no tester can run |
| Multi-surface use cases, marked as flows | the end-to-end journey cases in Stage 3's section K |
| The `Module` on every row | the column that makes the one scope-wide CSV filterable |
| Gaps | cases marked as assumption-derived, and coverage recorded as `Unknown` rather than `Covered` |

# 9. Anti-patterns

| Anti-pattern | Why it is wrong |
|---|---|
| Inferring a constraint from a field name | `email`, `phone`, `url` are frequently unvalidated. The name is not the rule. |
| "Validates input correctly" | Not falsifiable. Nothing can be tested from it. |
| Recording one rule for "rejects expired or used codes" | Two failure modes, two tests. One row hides one of them. |
| Copying a docstring as a rule | Docstrings are intent. Cite the enforcing line, and record the discrepancy if there is one. |
| Omitting a field because it has no validation | The absence *is* the finding — and often the defect. |
| Resolving a DTO/DB conflict silently | The gap between the two layers is where the bug is. |
| Marking `Inferred` as `Confirmed` to look thorough | Destroys the one property that makes this spec trustworthy. |
| Reading only the happy path of a handler | Every branch not read is an exception flow not covered. |
| Stopping at the service the handler calls | The rule that computes the money is usually one level further down. Read to the bottom of the closure. |
| Treating an in-repo callee as a black box | Its source is right there. Reading it converts an assumption into an evidenced rule. |
| Recording an `EXT` dependency as one rule that says it can fail | Each failure mode is a different input with a different observable outcome. One row per mode. |
| Assuming a boundary failure is handled because handling it would be sensible | The absence of handling is the finding, and it is usually a real defect. |
| Recording only the entry-point constraint | The tightest limit on the path is the effective one; the gap between layers is where the defect lives. |
