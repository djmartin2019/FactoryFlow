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
