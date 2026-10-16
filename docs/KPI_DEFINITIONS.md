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
| Wait | `startedAt` − previous step's `completedAt` (order `releasedAt` for the first step), minutes, floored at 0 |
| Processing | `completedAt` − `startedAt` − hold, minutes |
| Hold | `pausedMinutes`: time the operation was paused by a machine failure |

N/A until the step has started (wait) or completed (processing, hold). Rework and re-test attempts are separate
rows with their own times. Work-center names label steps only; they do not constrain which station runs a step.

## N/A rules
- Utilization: N/A until at least one scheduled shift minute has elapsed in the window (e.g. at simulation start, weekends only).
- First-pass yield: N/A when no round-1 inspection completed in the window.
- Counts and sums show `0`, a real measured value.

## Limitations
- Good units are attributed to the finished-goods receipt time, not build time (one receipt event per order).
- Utilization excludes machine-downtime overlap but counts any run time after 18:00 against the shift (capped at 100% per station).
- Per-station queue length is the existing `workstationViews` definition: ASSEMBLY stations share the global WAITING queue; INSPECTION stations show orders AWAITING_QC. It is not a per-station dispatch assignment.
- Dataset is synthetic; these are demonstration measurements, not operational data. The UI carries the label "Demo Mode — Synthetic Manufacturing Data".
