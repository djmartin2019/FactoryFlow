# Dashboard KPI definitions

All values are computed in `src/manufacturing/dashboardMetrics.ts` from `FactoryState`
(event-sourced replay state) at the single simulated timestamp owned by
`SimulationController`. Nothing is hardcoded or random. Source of truth for the
UI tooltips is `KPI_DEFINITIONS` in the same file.

**Measurement period** (selector in the header, default *Last 24 h*): `Last 24 h`,
`Last 7 d`, or `Since start`. The window is `(max(simStart, now − period), now]`.
It only affects the *historical* KPIs below; *current* KPIs are instantaneous.

| KPI | Kind | Definition | Numerator / Denominator | Source |
|---|---|---|---|---|
| Good units produced | Historical | QC-approved units received into finished goods in the window | Σ `finishedGoodsReceivedQuantity` of orders whose `completedAt` is in the window | `productionOrders[]` |
| Work in progress | Current | Units consumed into production, not yet finished or scrapped | Σ `wipQuantity` over all orders | `productionOrders[].wipQuantity` |
| Active production orders | Current | Released or blocked orders | count of `status ∈ {WAITING, RUNNING, BLOCKED}` | `productionOrders[].status` |
| Workstation utilization | Historical | Busy ÷ scheduled shift time of all workstations | Σ per-station `min(shift, busy)` ÷ (stations × shift minutes, Mon–Fri 06:00–18:00 UTC) | `productionOperations[]`, `downtimes[]`, calendar |
| First-pass quality yield | Historical | Share of units passing round-1 inspection | Σ `passedQuantity` ÷ Σ `inspectedQuantity` for round-1 inspections with `inspectedAt` in window | `qualityInspections[]` |
| Blocked by material shortage | Current | Orders currently blocked for lack of material | count of `status = BLOCKED` and `blockReason = MATERIAL_SHORTAGE` | `productionOrders[]` |

## Work-order operation times (drawer, not a dashboard KPI)

Per routing step attempt, shown in the work-order detail:

| Measure | Definition |
|---|---|
| Wait | shift minutes between the previous step's `completedAt` (order `releasedAt` for the first step) and `startedAt`; off-shift time is excluded |
| Processing | `completedAt` − `startedAt` − hold, minutes |
| Hold | `pausedMinutes`: time the operation was paused by a machine failure |

N/A until the step has started (wait) or completed (processing, hold). Rework and re-test attempts are separate
rows with their own times. Work-center names label steps only; they do not constrain which station runs a step.

## Work-center load (Explorer "Work Centers" tab)

| Measure | Definition |
|---|---|
| Queued orders / units | Orders whose next step is this work center, ready (predecessors complete, order released) and not started; units = step quantity |
| Queued standard minutes | Σ `plannedMinutes` of the queued steps |
| Per station | queued standard minutes ÷ stations serving the work center |
| Oldest wait | shift minutes between the previous step's completion (order release for the first step) and now, longest queued step; nights and weekends are not waiting because nothing can start |
| In process | units of steps running or paused at the work center |
| Utilization | run time excluding failure holds ÷ (serving stations × shift minutes) in the reporting period; stations serving several work centers share capacity, so values are indicative |
| Waiting on equipment | Queued steps (a subset of queued orders) whose required equipment kind has no free unit right now |
| Setup min (changeovers) | Σ applied setup minutes of steps that started in the period; in brackets, how many followed a different product at that work center. Applied setup is the changeover rule for the station's last product at that work center, else the routing's standard; a repeat of the same product is cheaper, a switch dearer. Rework is exempt |
| Bottleneck candidate | work center with the largest queued standard minutes per station among those with a queue; at most one. Not flagged while the plant is off shift (Mon-Fri 06:00-18:00 UTC), when stations cannot start work |

### Equipment (below the Work Centers table)

| Measure | Definition |
|---|---|
| Held by | order whose running or paused step holds the unit now; "free" otherwise |
| Utilization | shift minutes the unit was held in the reporting period ÷ shift minutes (held includes time paused by a station failure) |
| Steps waiting | ready steps that cannot start because every unit of this kind is held; a step needing several kinds counts under each missing one |

Equipment is a capacity limit, not yet a failure source. The bottleneck candidate still ranks by queued minutes per station, so a work center blocked on equipment can be flagged without a station being the limit; read the "waiting on equipment" column alongside it.

The 3D plant draws the same queue (one box per queued order, amber pad on the bottleneck candidate) from `workCenterQueues`, so the view and the table share one definition.

It marks where WIP waits, not why: a long queue can come from lane capacity, a failure upstream, or a burst of releases.

## N/A rules
- Utilization: N/A until at least one scheduled shift minute has elapsed in the window (e.g. at simulation start, weekends only).
- First-pass yield: N/A when no round-1 inspection completed in the window.
- Counts and sums show `0`, a real measured value.

## Limitations
- Good units are attributed to the finished-goods receipt time, not build time (one receipt event per order).
- Utilization excludes machine-downtime overlap but counts any run time after 18:00 against the shift (capped at 100% per station).
- Per-station queue length (`workstationViews`): for ASSEMBLY stations, orders whose next step belongs to a work center the station serves (orders with a ready step in a shared lane count at every station serving it); for INSPECTION stations, orders AWAITING_QC. It is not a dispatch assignment.
- Dataset is synthetic; these are demonstration measurements, not operational data. The UI carries the label "Demo Mode — Synthetic Manufacturing Data".

## Proposed, not implemented: dispatch, lead time and work-order time (slice S1)

**Status by part.** The *Order metrics (S1a)* and *On-Time In-Full Dispatch* tables below are **IMPLEMENTED** (`src/analytics/dispatch.ts`, Explorer "Dispatch" tab, `tests/dispatch.test.ts`). Everything else in this section (work-order flow and cycle time, the exclusive categories A, the conditions B, and the reconciliation with the drawer) is **PROPOSED / NOT IMPLEMENTED** (slice S1b). The section defines semantics before any card, tab or
chart exists (see `CLAUDE.md`). Scope is release 0.1.0 (`docs/OPEN_SOURCE_DEVELOPMENT_PLAN.md` §E.3). Everything here
reports **observed facts** from events and state. There is no forecast and no predicted delivery risk; "at risk" is not a
term used by this section. Slices S1a and S1b are approved against these definitions (plan §L8); a part is marked implemented only when its code and tests exist.

### Dispatch, not delivery

The model records shipment **dispatch**, not customer receipt. FactoryFlow does not know when goods reached a customer, and no
user-facing label may say "delivery", "delivered" or "on-time delivery". Metric names use *dispatch* throughout. Field names
(`dueDate`, `dispatchedAt`) are unchanged.

**Synthetic-domain assumption (not a universal definition).** For the synthetic reference manufacturer, `CustomerOrder.dueDate` is
treated as a **dispatch-by** date. Another source's due date may mean ship-by, deliver-by or something else; its adapter contract
must say which. If it does not mean dispatch-by (or is unknown), the dispatch-basis metrics below must be labelled accordingly or
withheld for that source, never silently reinterpreted.

### What the current model can and cannot say

| Fact | In the model? | Consequence |
|---|---|---|
| Customer order `createdAt`, `dueDate`, status (`OPEN`, `PARTIALLY_SHIPPED`, `SHIPPED`, `CANCELLED`), per-line `quantity` / `allocatedQuantity` / `shippedQuantity` | Yes | Order metrics below are computable |
| Shipment `dispatchedAt`, per-line quantities; several shipments per order | Yes | Partial dispatches are visible |
| `FINISHED_GOODS_ALLOCATED` events (customer order line, quantity, time) | Yes; the reducer rejects a shipment line larger than the line's allocated quantity | Allocation always precedes dispatch |
| Customer **receipt** date, proof of delivery, carrier transit time | **No** | Transit time is not measurable (deferred); nothing here claims receipt |
| Which work order's units fill which customer order | **No.** `ProductionOrder.demandLineIds` records the order lines a work order was *planned to satisfy*; finished goods enter a pool and are allocated to lines from stock | The order-to-work-order link is a **planning link, not proven unit flow**. Decomposing an order's lead time into its work orders' phases is **deferred** to unit/lot traceability (design Phase 2) |

### Order metrics (S1a) — IMPLEMENTED

| Metric (user-facing name) | Definition |
|---|---|
| Final-dispatch instant | `dispatchedAt` of the shipment after which every line has `shippedQuantity = quantity` (status `SHIPPED`). Defined only for `SHIPPED` orders |
| **Order-to-Final-Dispatch Lead Time** | final-dispatch instant - order `createdAt`, in minutes. **N/A** for open, partially dispatched and cancelled orders. It is not a work-order cycle time and not the sum of any |
| Lead-time milestone segments | Three consecutive, mutually exclusive segments summing **exactly** to the lead time: (1) `createdAt` to the first `FINISHED_GOODS_ALLOCATED` for the order; (2) first allocation to first dispatch; (3) first dispatch to final dispatch (zero for a single shipment). Named for the milestones that bound them, not for causes. If a shipped order has no allocation event in the log, the segment boundaries are **unavailable** and only the total is shown |
| **Dispatch Lateness** | max(0, final-dispatch instant - `dueDate`) in minutes for `SHIPPED` orders; **N/A** otherwise |
| **Past-Due Unshipped Orders** | Orders with status `OPEN` or `PARTIALLY_SHIPPED` (not fully dispatched) and `dueDate <= asOf`, shown with minutes past due (`asOf - dueDate`), unshipped quantity, and how many are partially dispatched. A fact about now, not a prediction |
| Time to Due Date (open orders) | For open orders not yet due: `dueDate - asOf`, with unshipped quantity and the status of linked work orders (a planning link). Calendar arithmetic only: it says nothing about whether the order will be late |
| Cancelled orders | Excluded from every rate and count here; reported as their own count. A cancellation after a partial dispatch is excluded and flagged |

### On-Time In-Full Dispatch (dispatch basis) — IMPLEMENTED

| Measure | Definition |
|---|---|
| Cohort | Non-cancelled orders whose `dueDate` falls in the reporting window **and** `dueDate <= asOf` (the existing measurement period selector). Cohorting by due date avoids survivorship bias: an order still unshipped after its due date stays in the denominator |
| **On-Time In-Full Dispatch** rate | numerator = cohort orders whose final-dispatch instant exists and is `<= dueDate`; denominator = cohort size. Unshipped overdue orders count in the denominator and not the numerator. An order dispatched in part by the due date and completed later is **not** in the numerator (partial dispatch does not satisfy "in full") |
| **Quantity Fill by Due Date** (separate metric) | Σ over cohort lines of shipped quantity with `dispatchedAt <= dueDate` ÷ Σ ordered quantity. A partial-dispatch-aware companion, shown beside the rate and never in place of it |
| **On-Time Dispatch Rate** (secondary, shipment level) | Among non-cancelled shipments with `dispatchedAt` in the window, the share with `dispatchedAt <= ` their order's `dueDate`. Counts each shipment once, so a late balance shipment does not erase an on-time first shipment. N/A when no shipment is in the window. May be omitted from the 0.1.0 UI if it clutters; it is not a substitute for On-Time In-Full Dispatch |
| Past-Due Unshipped Orders | As above, shown beside the rate |
| N/A | Rates are **N/A** (not 0) when their cohort is empty. Lead-time statistics are N/A when no order reached final dispatch in the window |

Lead-time statistics (median, P90) cover `SHIPPED` orders whose final-dispatch instant is in the window and say so in their label. Percentiles use the **nearest-rank** method on the ascending lead times (rank = ceil(p x n)). Windows are the existing half-open `(from, to]` period windows, clipped to the start of the data, so orders due before the data starts are outside "Since start".

**Implementation notes (S1a).** Durations are kept in milliseconds internally and rounded only for display, so the segment identity is exact. The final-dispatch instant is derived by accumulating an order's shipments (ordered by dispatch time, then id) until every line is fully shipped; a `SHIPPED` order for which that cannot be derived is excluded from the cohort and reported as *indeterminate* (zero on the default dataset). Under the current reducer an order can only be cancelled while `OPEN` and unshipped, so a cancellation after a partial dispatch cannot occur; cancelled orders are excluded and counted regardless. The planned-work-orders list comes from `ProductionOrder.demandLineIds`.
They exclude open orders, which biases them low while many orders are open; the view shows the open count beside them.

### Work-order flow time versus cycle time versus order lead time (S1b, PROPOSED)

| Measure | Definition |
|---|---|
| Work-order flow time | `completedAt` - `createdAt` (a `COMPLETED` work order). Includes pre-release time |
| Work-order cycle time | `completedAt` - `releasedAt` (shop-floor time after material is reserved) |
| Relationship | Neither is a component of order lead time. A customer order may be filled from stock with no work order, and its linked work orders are a planning link |

### A. Mutually exclusive elapsed-time categories (work order, S1b, PROPOSED)

A decomposition of **one work order's** elapsed time in which every instant belongs to **exactly one** category, built from the
event log and replayed state. It is **not** defined at customer-order level (planning-link note above). It is descriptive: it says
what state the work order was in, never why.

**Window and intervals.** `[createdAt, end)` where `end = completedAt` for a `COMPLETED` order and `asOf` for an open one (flagged
"open"); cancelled orders are excluded. Boundaries are the timestamps of the order's events plus the working-calendar boundaries
(`calendar.ts`: Mon-Fri 06:00-18:00 UTC, the same `shiftMinutesBetween` the drawer uses). Between consecutive boundaries the state is
constant: it is the state after applying every event with a timestamp `<=` the interval start, in `sequence` order. Intervals are
half-open `[start, end)`; events sharing a timestamp produce zero-length intervals and contribute nothing.

**Classification by eligibility** (each category is defined by a state predicate; the predicates are mutually exclusive on any log
the reducer accepts, which is a required test). "Open operation" means an operation of this order whose status is not `COMPLETED`,
including rework and re-test operations once `REWORK_REQUESTED` has added them.

| Category | Eligible when (state in the interval) | Notes |
|---|---|---|
| `PRE_RELEASE` | order exists, not released (`releasedAt` unset), not blocked | status `PLANNED` |
| `MATERIAL_BLOCKED` | status `BLOCKED` with `blockReason = MATERIAL_SHORTAGE` | The reducer permits this block only on a `PLANNED` order and clears it at release |
| `HELD_MACHINE_DOWN` | some operation of the order has status `PAUSED` | From `PRODUCTION_BLOCKED` (`MACHINE_DOWN`) until `PRODUCTION_RESUMED` |
| `PROCESSING` | some operation has status `RUNNING` | Includes rework and re-test; includes the final-test operation, in which the inspection is recorded. Setup/changeover minutes are inside the operation and are reported as a **share of** processing, not a category |
| `QUEUE_WAIT` | order released, not blocked, and not `COMPLETED`/`CANCELLED`; no operation `RUNNING` or `PAUSED`; **at least one open operation exists** (it is then `PENDING` and, because the reducer starts operations strictly in `sequence`, it is the next to start); and the interval is **inside** the working calendar | Waiting to start the next operation: for a station or equipment, or after a rework/re-test operation has been requested. Includes the time between release and the first operation's start. Says nothing about which resource is the cause |
| `OFF_SHIFT` | the same predicate as `QUEUE_WAIT`, but the interval is **outside** the working calendar | Only waiting time is split by the calendar; processing continuing past 18:00 stays `PROCESSING` |
| `POST_PRODUCTION` | order released and not `COMPLETED`/`CANCELLED`; no operation `RUNNING`/`PAUSED`; **no open operation**; at least one operation exists and all are `COMPLETED`; `awaitingQcQuantity = 0` and `reworkPendingQuantity = 0`; order not blocked | Time between the last operation's completion and `FINISHED_GOODS_RECEIVED` (`completedAt`). Does not claim that inspection, acceptance or any other activity occurred in it; in this model the inspection is recorded inside the final-test operation, which is `PROCESSING`. Not split by calendar |
| `UNCLASSIFIED` | everything else | Explicit remainder; see below |

**What lands in `UNCLASSIFIED`.** Any interval no predicate claims: for example inspected units awaiting a rework request with no open
operation yet (`reworkPendingQuantity > 0`, no rework operation added), a blocked state that is neither material nor a paused operation,
an order with no operations, or inconsistent/missing events from an imported source. These are shown, never hidden or reassigned. A
non-zero value on the simulation dataset is a defect to investigate. **Expected on simulated data:** `POST_PRODUCTION` and the rework-request
gap are zero-length, because the generator emits `FINISHED_GOODS_RECEIVED` at the same timestamp as the final `OPERATION_COMPLETED`
and `REWORK_REQUESTED` at the same timestamp as the inspection; the categories exist for sources that record a gap, and this expectation is to be confirmed
by the S1b test, not assumed.

**Precedence.** Because eligibility is the primary mechanism, no precedence is needed on valid logs. As a deterministic safeguard for
imported or corrupt data where two predicates could hold at once, the order is `HELD_MACHINE_DOWN` > `PROCESSING` > `MATERIAL_BLOCKED` >
`QUEUE_WAIT`/`OFF_SHIFT` > `PRE_RELEASE` > `POST_PRODUCTION` > `UNCLASSIFIED`, and the number of instants where a tie occurred is reported as a
data-quality count (zero on the simulation). The tests assert it is zero on every accepted log rather than relying on the tie-break.

**Reconciliation (the tested identity).** For every work order, in exact timestamp arithmetic: Σ over all categories (including
`UNCLASSIFIED`) = `end - createdAt`. Display is in minutes; the identity is checked before any rounding. Unrecorded activities are never
assumed and no events are invented; where the model cannot tell what happened, the interval is `UNCLASSIFIED` or the limitation is stated.

**Missing data.** A category whose defining state a source cannot supply (for example no pause history, or no material-block history) is reported
**unavailable** by capability, and its instants fall to `UNCLASSIFIED` or to the neighbouring category the source can support, with the decomposition labelled
**coarse**. It is never silently zero. The simulation supplies every state named above.

### Relationship to the existing step Wait / Processing / Hold (implemented drawer measures)

The drawer (`workOrderDetail`, `analytics/workOrders.ts`) is implemented and is **not changed** to suit this section. What it measures, per
*started* step: `Wait` = `Math.round(shiftMinutesBetween(readyAt, startedAt))`, where `readyAt` is the order's `releasedAt` for the first step and the
previous **completed** step's `completedAt` thereafter; `Processing` = rounded elapsed minutes - `pausedMinutes`; `Hold` = `pausedMinutes` (rounded per pause by the reducer).

| Question | Answer |
|---|---|
| Intervals the step Wait covers | Only waits that **ended in a start**: `[readyAt, startedAt)` of each started step, counted in in-shift minutes only. A wait still in progress (next step not started) is not shown. Each value is rounded to a whole minute |
| Intervals `QUEUE_WAIT` covers | All in-shift time meeting the eligibility predicate: the same closed waits, **plus the open wait** of an in-progress order, in exact (unrounded) time |
| Equivalent? | **No**, not as stated. They agree on the *common subset*: closed waits, in-shift, unrounded |
| In the drawer but not in `QUEUE_WAIT` | Rounding (up to 0.5 minute per step); any rework-request gap between a failed inspection and `REWORK_REQUESTED` if the two events have different timestamps (the drawer treats it as wait, the decomposition as `UNCLASSIFIED`) |
| In `QUEUE_WAIT` but not in the drawer | The open wait at `asOf`; exactness (no rounding) |
| Off-shift waiting | In neither the drawer's `Wait` nor `QUEUE_WAIT`; it is `OFF_SHIFT`. The drawer's Wait plus `OFF_SHIFT` over the same closed intervals equals the elapsed time of those intervals |

**Valid reconciliations (acceptance tests for S1b).** For every work order of the default dataset, and for hand-built fixtures:
1. *Closed waits, exact:* Σ over started steps of the unrounded `shiftMinutesBetween(readyAt, startedAt)` equals `QUEUE_WAIT` restricted to intervals that end at an `OPERATION_STARTED` of this order (the "closed" part), exactly, for every order whose rework-request gap is zero. On the simulation the gap is expected to be zero; if the test finds a non-zero gap, report it as the known difference above rather than weakening the test.
2. *Drawer display, bounded:* |Σ displayed step `Wait` - closed `QUEUE_WAIT`| <= 0.5 minute x (number of started steps).
3. *Completed orders:* `QUEUE_WAIT` equals the closed part (no open wait remains); for an open order, `QUEUE_WAIT` = closed part + the open tail, and the tail is reported separately.
4. *Processing and Hold:* for completed steps, Σ step `Processing` + Σ step `Hold` equals the `PROCESSING` + `HELD_MACHINE_DOWN` time of the same steps within rounding (<= 0.5 minute per step and per pause); `pausedMinutes` is rounded per pause by the reducer, so the exact event-derived `HELD_MACHINE_DOWN` may differ from it by that bound. Report any larger difference instead of adjusting either side.
5. *Never asserted:* equality of the drawer's `Wait` with `QUEUE_WAIT` over the whole work-order life, or with any category that includes the open wait, off-shift time, `POST_PRODUCTION` or `UNCLASSIFIED`.

### B. Overlapping contributing conditions (not a partition; S1b, PROPOSED)

Conditions that may hold at the same time, during the same order's wait, and **must not be summed, stacked or presented as
shares of elapsed time**. They are *descriptive indicators of context*, labelled *contributing conditions* or *indicative causes*, never
proven root causes. They do not change the A categories. A reader must be told that two conditions can both be present in the same minute.

| Condition | Measured from | Availability in 0.1.0 |
|---|---|---|
| Material shortage | the `MATERIAL_BLOCKED` interval above | Event history; a duration |
| Station unavailable | downtime intervals (`MACHINE_FAILED` to `MACHINE_RESTORED`) of stations serving the next step's work center while that step waited | Event history; a duration |
| Changeover | applied setup minutes (`setupMinutes` on `OPERATION_STARTED`) | Event history; part of `PROCESSING`, so it never overlaps `QUEUE_WAIT` |
| Equipment unavailable | no free unit of a required kind for a ready step | **Current-state observation only**, as of `asOf` ("waiting on equipment now", as the Work Centers tab already shows). Not a historical duration; no history is reconstructed |
| Work-center backlog | queued standard minutes ahead of the step at its work center | **Current-state observation only**, as of `asOf`. Not a historical duration; no queue-over-time series in 0.1.0 |
| Off shift | plant outside the working calendar | Event/calendar; also the exclusive `OFF_SHIFT` category in A, listed here only as a condition |
| Quality hold | not modeled (incoming quality hold is design Phase 3) | **Deferred**; inspection queueing appears as `QUEUE_WAIT`/`PROCESSING`, not as a hold |

Current-state observations are labelled "current state at <asOf>". Historical equipment and backlog analysis may be added later only through a tested
event-walk implementation, and only if justified.

### Release 0.1.0 reporting boundary

Report: Order-to-Final-Dispatch Lead Time and milestone segments, Dispatch Lateness, Past-Due Unshipped Orders, Time to Due Date, On-Time In-Full
Dispatch and Quantity Fill by Due Date (and, optionally, On-Time Dispatch Rate), work-order flow and cycle time, the exclusive decomposition A, and the
conditions B marked available. **Deferred:** predicted delivery risk or any "will be late" indicator (needs a capacity model, design Phase 4), transit and
customer-receipt time, order-level decomposition into work-order phases, quality-hold time, historical equipment and backlog durations.
