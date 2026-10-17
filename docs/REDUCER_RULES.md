# Reducer rule classification

**Documentation only.** Nothing in `src/manufacturing/state.ts` changed. This is the M1 deliverable of
`docs/SOURCE_INTEGRATION_PLAN_REV3.md` (section 7.9, Appendix A): every `req(...)` in the reducer, sorted into five
classes, so that source adapters, ingest quarantine and a future recording profile talk about the same rules.
`src/sources/types.ts` declares the classes (`RuleClass`); M7 attaches them to typed error codes.

The strict reducer is unchanged and stays strict. A class says *why a real source might legitimately disagree with a
rule*, not that the rule may be skipped.

## Classes

| Class | Meaning | Real sources |
| --- | --- | --- |
| `LOG` | Properties of the event log itself: contiguous `sequence`, non-decreasing timestamps. | Owned by ingest; always true after ingest |
| `REFERENCE` | Unknown or duplicate ids, missing dependencies. | Recoverable by supplying the missing data; not a statement that the fact is wrong |
| `INTEGRITY` | Cannot be accepted without breaking basic consistency: arithmetic identities inside one record, state-machine legality, no double posting. | Violations mean a data gap or a bad feed |
| `PLAN_CONFORMANCE` | Equality to the plan or a simulation policy: routing shape, BOM and reservation equality, planned quantities, changeover table, station eligibility, balance equalities. | Real systems legitimately report variance |
| `AMBIGUOUS` | Depends on process or source semantics: backflush versus explicit consumption, concurrent stations, tolerances, negative stock from late postings. | The pilot must decide (section 7.9) |

## Rules

Line numbers refer to `src/manufacturing/state.ts` at schema 1.3.0. `tests/reducerRules.test.ts` fails if a `req(` is
added, moved out of every listed range or removed without updating this table, so refactors (M3a) must update it.
Rows marked `*` were not in Appendix A of the plan and are classified here by the same criteria.

<!-- rules:start -->
| Lines | Rule | Class | Why | Real-world counter-example |
| --- | --- | --- | --- | --- |
| 248, 249 | `sequence === lastSequence + 1`; timestamp not before `asOf` | `LOG` | Ingest assigns the sequence and orders the log | none after ingest |
| 253, 258, 263, 268, 273 | Lookups: unknown location, production order, operation, workstation, customer order | `REFERENCE` | Missing dependency | event arrives before its entity |
| 198, 283, 288, 300, 309, 347, 350, 379, 382, 659, 709, 730 * | Unknown or missing supplier, material, PO, PO line, customer, product, BOM, routing, inspection, order line | `REFERENCE` | Missing dependency; recoverable by supplying it | master data lags the transactions |
| 282, 298, 326, 346, 378, 390, 526, 636, 668, 723, 750 | Duplicate id of PO, receipt, transfer, customer order, production order, operation, assignment, inspection, shipment, downtime | `REFERENCE` | Same id twice; resolved upstream by idempotency groups | source re-sends the same transaction |
| 167 * | Inventory deltas are integers | `INTEGRITY` | Arithmetic within one record | decimal quantities from a unit-of-measure mismatch |
| 285, 290, 303, 311, 327, 328, 348, 351, 380, 710, 727 | Creation-state identities and positive quantities: PO and order start OPEN/PLANNED with zero progress, quantities positive, transfer has two locations, receipt and shipment have lines | `INTEGRITY` | Identity of a single record | an ERP reports an already-received PO on first sight (then it is an observation) |
| 306, 310, 392 * | A receipt lists a PO line once; receipt material equals the PO line's; `operationIds` lists the order's operations in order | `INTEGRITY` | Consistency within one record | duplicate receipt lines for split deliveries |
| 640, 641, 642 | Inspection: passed + failed = inspected; rework + scrap = failed; defect counts = failed | `INTEGRITY` | Arithmetic within one record | defect codes missing for failed units (then `AMBIGUOUS`) |
| 401, 405, 460, 461, 463, 464, 476, 479, 480, 498, 499, 522, 543, 544, 545, 556, 598, 601, 612, 621, 624, 637, 638, 643, 679, 683 *, 707, 725, 726 *, 749, 771, 772 | State-machine legality and no double posting: cannot release, consume, start, complete, resume, inspect, receive or ship in the wrong status; machine failure on a DOWN station and restore without an open downtime are rejected; rework quantity cannot go negative | `INTEGRITY` | Cannot complete what never started | missing "start" event from a source (then a data gap: quarantine); duplicate failure feed |
| 546 | Predecessor operations completed before an operation starts | `PLAN_CONFORMANCE` | Routing plan | overlapped operations (design 3.1) |
| 383, 386, 388 | Operations match the routing step for step, with the order quantity | `PLAN_CONFORMANCE` | Routing plan | skipped or added steps, split quantities, routing revisions |
| 407, 409 | Reservations equal the BOM requirement exactly and cover the BOM | `PLAN_CONFORMANCE` | Plan equality | substitutes, partial reservation, overage |
| 500, 504, 505, 506 | Consumption equals reservation and BOM, from the reserved location | `PLAN_CONFORMANCE` | Plan equality | consumption variance, scrap, a different bin |
| 561, 565 | Setup minutes equal the changeover table or standard; changeover origin equals the station's history | `PLAN_CONFORMANCE` | Simulation table | actual 47 min against planned 30 min |
| 570, 571, 574 | Exactly one free unit of each required equipment kind | `PLAN_CONFORMANCE` | Eligibility plan | tooling unrecorded; alternative equipment |
| 625 | `quantityProduced === order.quantity` | `PLAN_CONFORMANCE` | Plan equality | yield variance, partial completion |
| 622 | Production completes on the station of the last assembly operation | `PLAN_CONFORMANCE` | Simulation assumption | multi-station routing |
| 639 | Inspected quantity equals units awaiting QC and the operation quantity | `PLAN_CONFORMANCE` | Plan equality | sampling, partial inspection |
| 644, 660, 661, 664, 665, 667 | Rework once only; rework adds exactly a REWORK and a FINAL_TEST operation of the failed quantity | `PLAN_CONFORMANCE` | Simulation policy | repeated rework |
| 680, 681, 682, 684, 694 | FG receipt equals approved minus received, WIP closes to exactly zero, no receipt while rework or operations are outstanding | `PLAN_CONFORMANCE` | Balance equalities and quality-gate policy | partial receipts, over-receipt, units unaccounted for |
| 711, 731 | Allocation not above open quantity; shipment not above allocated | `PLAN_CONFORMANCE` | Order-fulfilment policy | ship from stock without an allocation step |
| 174 | Inventory: `reserved <= onHand` | `PLAN_CONFORMANCE` | Reservation is a plan construct | allocations above stock (backorders) |
| 447, 448, 452, 456 | Shortage block: only a PLANNED order; claimed required and available must match computed inventory | `AMBIGUOUS` | Verifies a producer-derived claim against our possibly incomplete inventory | the source's own shortage view differs |
| 523 | Starting requires materials already consumed | `AMBIGUOUS` | Consumption-before-start is a posting convention | backflush at completion |
| 525, 549 | Station must be IDLE and not DOWN (capacity 1) | `AMBIGUOUS` | Resource exclusivity as modelled | missing completion posting; concurrent jobs |
| 548, 552 | Workstation kind and work center serve the operation | `AMBIGUOUS` | Eligibility table | mapping gaps |
| 172, 173 | Inventory: `onHand >= 0`, `reserved >= 0` | `AMBIGUOUS` | Physical balance can go negative from late postings | backflush before receipt |
| 284, 302, 410, 507, 524 *, 685, 712 *, 732 * | Location kinds: receiving, raw storage, assembly, assembly workstation, FG location | `AMBIGUOUS` | Canonical location typing; an adapter mapping concern | plants without these location kinds |
| 289 | Material supplied by the PO's supplier | `AMBIGUOUS` | Approved-supplier policy | alternate suppliers |
| 301, 312 | Receipt not above ordered; PO not already received | `AMBIGUOUS` | Tolerance policy | over-receipt, receiving against a closed PO |
| 359, 427, 428 | Cancel only before start or consumption; customer order cancel only when OPEN | `AMBIGUOUS` | Policy | cancel after start with WIP or scrap |
| 140, 141 * | Opening balances only on the initial state, non-negative integers | `INTEGRITY` | Setup helper, not an event rule | n/a |
<!-- rules:end -->

## Notes

- **Roughly:** the strict reducer is mostly `PLAN_CONFORMANCE` and `AMBIGUOUS` for anything involving quantities and
  plan, and `INTEGRITY`, `REFERENCE` and `LOG` for structure. A recording path is therefore not a small relaxation; it
  needs its own acceptance rules (plan section 7.9).
- **Cascade caveat.** In the strict profile a `PLAN_CONFORMANCE` rejection of one event blocks everything that depends
  on it (a rejected `OPERATION_STARTED` blocks that operation's completion and the order's later events). Quarantine
  keeps the facts, but the strict dashboard will omit or truncate such orders. Whether a different ruleset profile is
  needed is the central question for the first real-data pilot.
- **Ambiguity within a class.** A few rows could be argued either way (for example 306, 310 and 643). They are placed by
  the reducer's current behavior and will be revisited with pilot data.
- **Out of scope here:** no rule is relaxed, renamed or given a code. M7 introduces typed codes with a `class`, backed by
  an exhaustive map and a test that fails for an unclassified code.
