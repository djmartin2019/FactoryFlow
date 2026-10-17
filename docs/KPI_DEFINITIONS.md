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

## Proposed, not implemented: delivery, lead time and work-order time (slice S1)

**Status: PROPOSED. No code computes anything in this section yet.** It defines semantics before any card, tab or
chart exists (see `CLAUDE.md`). Scope is release 0.1.0 (`docs/OPEN_SOURCE_DEVELOPMENT_PLAN.md` §E.3). Everything here
reports **observed facts** from events and state. There is no forecast and no predicted delivery risk; "at risk" is not a
term used by this section.

### What the current model can and cannot say

| Fact | In the model? | Consequence |
|---|---|---|
| Customer order `createdAt`, `dueDate`, status (`OPEN`, `PARTIALLY_SHIPPED`, `SHIPPED`, `CANCELLED`), per-line `quantity` / `allocatedQuantity` / `shippedQuantity` | Yes | Order lead time and lateness are computable |
| Shipment `dispatchedAt`, per-line quantities; several shipments per order | Yes | Partial shipments are visible |
| `FINISHED_GOODS_ALLOCATED` events (customer order line, quantity, time) | Yes; a shipment line cannot exceed the line's allocated quantity (reducer) | Allocation always precedes dispatch |
| Customer **receipt** date, proof of delivery, carrier transit time | **No** | "Delivery" here means **dispatch**; transit time is not measurable (deferred) |
| Whether `dueDate` means ship-by or deliver-by | Not stated | Documented here as **dispatch-by**; every on-time figure is labelled "dispatch basis". A real source's adapter must declare its meaning |
| Which work order's units fill which customer order | **No.** `ProductionOrder.demandLineIds` records the order lines a work order was *planned to satisfy*; finished goods enter a pool and are allocated to lines from stock (`FINISHED_GOODS_ALLOCATED`) | The order-to-work-order link is a **planning link, not proven unit flow**. Any decomposition of an order's lead time into its work orders' phases is **deferred** to unit/lot traceability (design Phase 2) |

### Order lead time (customer-facing)

| Measure | Definition |
|---|---|
| Completion instant | `dispatchedAt` of the shipment after which every line has `shippedQuantity = quantity` (status becomes `SHIPPED`). Defined only for `SHIPPED` orders |
| Order lead time | completion instant - order `createdAt`, in minutes. **N/A** for open, partially shipped and cancelled orders. It is **not** a work-order cycle time and is not the sum of any |
| Milestone segments | Three consecutive, mutually exclusive segments that sum **exactly** to the lead time: (1) `createdAt` to the first `FINISHED_GOODS_ALLOCATED` for the order; (2) first allocation to the first dispatch; (3) first dispatch to the completion instant (zero for a single shipment). They are named for the milestones that bound them, not for causes (segment 1 may be waiting for production, for stock or for nothing in particular). If a shipped order has no allocation event in the log, segment boundaries are **unavailable** and only the total is shown |
| Lateness | max(0, completion instant - `dueDate`) in minutes for `SHIPPED` orders; **N/A** otherwise |
| Past due, open | An order with status `OPEN` or `PARTIALLY_SHIPPED` and `dueDate <= asOf`. Shown with minutes past due (`asOf - dueDate`) and unshipped quantity. A fact about now, not a prediction |
| Time to due date | For open orders not yet due: `dueDate - asOf`, with unshipped quantity and the status of the linked work orders (as a planning link). Calendar arithmetic only: it says nothing about whether the order will be late |
| Cancelled orders | Excluded from every rate and count below; reported as their own count. A cancellation after a partial shipment is excluded and flagged |

### On-time delivery (dispatch basis)

| Measure | Definition |
|---|---|
| Cohort | Non-cancelled orders whose `dueDate` falls in the reporting window **and** `dueDate <= asOf` (the window's measurement period selector, as above). Cohorting by due date avoids survivorship bias: an order still unshipped after its due date stays in the denominator as late |
| On-time-in-full rate | numerator = cohort orders whose completion instant exists and is `<= dueDate`; denominator = cohort size. An order that shipped part by the due date and the rest later is **not** on time |
| Quantity fill by due date | Σ over cohort lines of shipped quantity with `dispatchedAt <= dueDate` ÷ Σ ordered quantity. A partial-shipment-aware companion; shown with the rate, never instead of it |
| Past-due open count | As above, for the same cohort, shown beside the rate |
| N/A | Rate and fill are **N/A** (not 0) when the cohort is empty. Lead-time statistics are N/A when no order completed in the window; use the completion instant for the window membership of lead-time statistics, and say so in the label |

Lead-time statistics (median, P90) are computed over `SHIPPED` orders whose completion instant is in the window, from the
exact lead times above. They exclude open orders, which biases them low while many orders are open; the view must show
the open count beside them.

### Work-order cycle time versus order lead time

| Measure | Definition |
|---|---|
| Work-order flow time | `completedAt` - `createdAt` (a `COMPLETED` work order). Includes pre-release time |
| Work-order cycle time | `completedAt` - `releasedAt` (shop-floor time after material is reserved) |
| Relationship | Neither is a component of order lead time. A customer order may be filled from stock with no work order, and the work orders linked to it are a planning link (above) |

### A. Mutually exclusive elapsed-time categories (work order)

A decomposition of **one work order's** elapsed time in which every instant belongs to **at most one** category, built from
the event log and state. It is supported by the current model for work orders completed or in progress, with the caveats
below. It is **not** defined at customer-order level (see the planning-link note).

Window: `[createdAt, end)` where `end = completedAt` for a completed order and `asOf` for an open one (flagged "open"). Cancelled
work orders are excluded. Intervals are half-open `[start, end)` on event timestamps; events with equal timestamps produce
zero-length intervals and contribute nothing. Events are applied in `sequence` order.

| Category | Instants it claims | Source |
|---|---|---|
| `HELD_MACHINE_DOWN` | A running operation of the order is paused: from `PRODUCTION_BLOCKED` (reason `MACHINE_DOWN`) to the matching `PRODUCTION_RESUMED` | events, `pausedMinutes` |
| `PROCESSING` | An operation (including rework and re-test attempts) is `RUNNING`: `OPERATION_STARTED` to `OPERATION_COMPLETED`, minus held intervals. Setup and changeover minutes are part of processing (they are inside the operation) and are reported as a **share of** processing, not as a separate category | events |
| `MATERIAL_BLOCKED` | From `PRODUCTION_BLOCKED` (reason `MATERIAL_SHORTAGE`) to `PRODUCTION_ORDER_RELEASED`. The reducer only allows this block on a `PLANNED` order and clears it at release | events |
| `OFF_SHIFT` | Not claimed above, released and not complete, and the plant is outside the working calendar (`calendar.ts`: Mon-Fri 06:00-18:00 UTC) | calendar |
| `QUEUE_WAIT` | Not claimed above, released, within a shift, and the order is not complete: waiting between operations, for a station or for equipment, or after rework is requested. May be attributed to the next operation's work center as a *breakdown dimension* (not an additional category) | events, calendar |
| `PRE_RELEASE` | From `createdAt` to release, when not `MATERIAL_BLOCKED` | events |
| `POST_PRODUCTION` | From the last operation's completion (or `PRODUCTION_COMPLETED`) to `FINISHED_GOODS_RECEIVED` / `completedAt`, when not claimed above (inspection and receipt latency not captured as operations) | events |
| `UNCLASSIFIED` | Any remaining instant | residual |

**Precedence** when more than one definition holds at an instant, highest first: `HELD_MACHINE_DOWN` > `PROCESSING` >
`MATERIAL_BLOCKED` > `OFF_SHIFT` > `QUEUE_WAIT` > `PRE_RELEASE` > `POST_PRODUCTION` > `UNCLASSIFIED`. A held interval sits
inside its operation's run interval, so it wins over `PROCESSING`; processing continuing past 18:00 stays `PROCESSING`.
The implementation is a sweep over the order's interval boundaries applying the precedence, so exclusivity holds by
construction rather than by convention.

**Reconciliation (the tested identity).** For every work order, in exact timestamp arithmetic:
Σ over all categories (including `UNCLASSIFIED`) = `end - createdAt`. `UNCLASSIFIED` is shown, never hidden, and a non-zero
value on the simulation dataset is a defect to investigate rather than rounded away. Display is in minutes; the identity is
checked before rounding.

**Crosswalk to the existing drawer measures** (above): Σ step Processing = `PROCESSING`; Σ step Hold = `HELD_MACHINE_DOWN`;
Σ step Wait (shift minutes) = `QUEUE_WAIT` over the same intervals. The two must agree in a test; a disagreement means one
of the definitions is wrong.

**Missing data.** A category whose defining events a source does not supply is reported **unavailable** (capability
flag), and its instants fall into the next lower-precedence category that applies. The decomposition is then labelled
**coarse**. It is never silently zero and never invented. The simulation supplies every event named above.

### B. Overlapping contributing conditions (not a partition)

Conditions that may hold at the same time, during the same order's wait, and **must not be summed, stacked or presented as
shares of elapsed time**. Each is measured independently as "minutes during which the condition held while the order was
open (or while its next step was ready)". Label them *contributing conditions* or *indicative causes*, never proven
root causes. A reader must be told that two conditions can both be responsible for the same minute.

| Condition | Measured from | Availability |
|---|---|---|
| Material shortage | the `MATERIAL_BLOCKED` interval above | Event history, available |
| Station unavailable | downtime intervals (`MACHINE_FAILED` to `MACHINE_RESTORED`) of stations serving the next step's work center while the step was ready | Event history, available |
| Equipment unavailable | no free unit of a required kind while the step was ready | Today's Work Centers tab shows this **right now** only. A historical value needs an event walk and is **limited to current state** until implemented and tested |
| Work-center backlog | queued standard minutes ahead of the step at its work center | Current state is available. History needs a walk; limited as above |
| Changeover | applied setup minutes (`setupMinutes` on `OPERATION_STARTED`) | Available; part of processing, so it never overlaps `QUEUE_WAIT` |
| Off shift | plant outside the calendar | Available; also an exclusive category in A, listed here only as a condition |
| Quality hold | not modeled (incoming quality hold is design Phase 3) | **Deferred**; inspection queueing appears as `QUEUE_WAIT` / `POST_PRODUCTION`, not as a hold |

### Release 0.1.0 reporting boundary

Report: order lead time and milestone segments, lateness, past-due open orders, time to due date, on-time-in-full and
quantity fill (dispatch basis), work-order flow time and cycle time, the exclusive decomposition A, and the conditions B that
are marked available. **Deferred:** predicted delivery risk or any "will be late" indicator (needs a capacity model, design
Phase 4), transit and customer-receipt time, order-level decomposition into work-order phases, quality-hold time, historical
equipment and backlog conditions unless implemented with tests.
