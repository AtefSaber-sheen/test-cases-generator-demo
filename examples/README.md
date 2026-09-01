# Worked example - Checkout

A miniature source tree, small enough to read in one sitting, for running the whole pipeline against.

```bash
# from the repository root
node tools/recon_scan/cli.js --repo examples/app
node tools/depgraph/cli.js   --repo examples/app --scope src/checkout
```

Then, in Claude Code:

```
Use the codebase-recon skill on examples/app, scope src/checkout.
Then behavior-spec, then test-design-from-code, then suite-export to ./out.
```

That produces the two deliverables - `out/TestCases_Checkout.csv` and `out/TestReport_Checkout.md` -
and nothing else. The generated pair is not committed here: it is output, and committing it would
put a generated artifact under review alongside the code that generates it.

## What is here

```
examples/
└── app/                                   a miniature source tree - the evidence base
    ├── src/checkout/checkout.controller.ts    2 routes, a JWT guard, an ownership check
    ├── src/checkout/dto/checkout.dto.ts       3 fields with real constraints
    ├── src/promotions/promo.service.ts        3 business rules, 2 typed errors
    └── prisma/schema.prisma                   2 entities, unique constraints, a cascade
```

It is deliberately tiny and deliberately awkward: the interesting behaviour is in the places where
the obvious test would be the wrong one.

## What a correct run should find

| In the source | What the suite should do |
|---|---|
| `@Min(1) @Max(99)` in `checkout.dto.ts` | A boundary set of **four** values - 0, 1, 99, 100 - with inclusivity read from the decorator rather than guessed, split into separate cases because the expected results differ |
| The ownership check in `checkout.controller.ts` | Assert **404, not 403**, because that is what the code does. Asserting the conventional 403 would fail against correct code |
| The role guard and the ownership check | Tested **separately**. Passing the role check is not passing the ownership check, and conflating them is how real vulnerabilities survive a green suite |
| The rounding rule in `PromoService.apply` | Driven through `POST /api/checkout` and asserted on the response `discount`. The evidence still cites the deep line, but the case is one a tester with an HTTP client can actually run - which a `Unit` case would not be |
| `cartId`, which has **no** validation | The absence is the finding, recorded as such - and the reason no boundary case for it is invented |
| The unreadable dependencies the closure reaches | One case per named failure mode per calling surface, asserting what the **caller** does - not "simulate a payment error" |
| Isolation levels across the cases | Several distinct scheduling groups, with anything touching a shared resource marked `exclusive:<resource>` rather than `read-only` to make the parallelism look better |

## What a correct run should refuse to do

- **No test for promotion stacking.** `PromoService.stack` is private and unreferenced, so no
  surface reaches it. That is `Unreachable-Black-Box` or `Unknown` - never `Covered`, and never
  silently omitted.
- **No illegal state-transition cases.** The `status` enum exists but no transition logic does in
  this scope. The evaluation grid should say `Not Applicable - no transition logic exists in this
  scope`, which is a decision; a blank cell would be an omission.
- **No cascade-delete test.** No surface deletes an order, so covering it would mean asserting the
  ORM's behaviour rather than the product's. `Uncovered`, with that reason stated.

Every one of those is a place where a plausible-looking test could have been written and would have
been wrong. Naming them is the point, and the report has a section for each.

## Checking the output

Two things are worth verifying by hand on any run:

1. **Every `Source Evidence` line number points at a real line** in `examples/app`. Open a few. A
   citation that does not resolve is the one failure mode that invalidates everything downstream.
2. **The report's Warnings section.** A clean run says `None - every case passed every check.`
   Anything else names the case and the field, and is worth reading before the cases are.
