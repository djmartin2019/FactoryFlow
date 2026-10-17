/**
 * Dispatch and lead-time read model (slice S1a). Semantics: docs/KPI_DEFINITIONS.md
 * ("dispatch, lead time and work-order time"), which is authoritative.
 *
 * Everything here is observed fact on a DISPATCH basis. The model records shipment dispatch, not customer
 * receipt, and `CustomerOrder.dueDate` is treated as dispatch-by (a synthetic-domain assumption). There is no
 * forecast. Durations are kept in milliseconds so identities hold exactly; callers round for display.
 */
import type { CustomerOrder, FactoryEvent, Id, Shipment } from "../manufacturing/types.ts";
import { periodWindow, inWindow, type PeriodId, type PeriodWindow } from "./periods.ts";
import type { ReportingSnapshot } from "./types.ts";

export const MS_PER_MINUTE = 60_000;

export interface LeadTimeSegments {
  /** createdAt to the first FINISHED_GOODS_ALLOCATED for the order. */
  toFirstAllocationMs: number;
  /** First allocation to first dispatch. */
  allocationToFirstDispatchMs: number;
  /** First dispatch to final dispatch (0 for a single shipment). */
  firstToFinalDispatchMs: number;
}

export interface OrderDispatchView {
  orderId: Id;
  customerId: Id;
  customerName: string;
  status: CustomerOrder["status"];
  createdAtMs: number;
  dueMs: number;
  orderedQuantity: number;
  shippedQuantity: number;
  unshippedQuantity: number;
  shipmentCount: number;
  firstAllocationMs: number | null;
  firstDispatchMs: number | null;
  /** Instant of the shipment after which every line is fully shipped; null unless the order is SHIPPED and it can be derived. */
  finalDispatchMs: number | null;
  /** finalDispatchMs - createdAtMs; null (N/A) unless the order reached final dispatch. */
  leadTimeMs: number | null;
  /** Null when no allocation event exists for a dispatched order (boundaries unavailable). */
  segments: LeadTimeSegments | null;
  /** max(0, final dispatch - due); null unless SHIPPED. */
  latenessMs: number | null;
  /** asOf - due for OPEN / PARTIALLY_SHIPPED orders that are past due; null otherwise. */
  pastDueMs: number | null;
  /** due - asOf for OPEN / PARTIALLY_SHIPPED orders not yet due; null otherwise. */
  timeToDueMs: number | null;
  partiallyDispatched: boolean;
  /** Work orders planned to satisfy this order's lines. A planning link, not proven unit flow. */
  plannedWorkOrderIds: Id[];
}

export interface Rate {
  numerator: number;
  denominator: number;
  /** 0..1; null (N/A) when the denominator is 0. */
  rate: number | null;
}

export interface DispatchReport {
  asOfMs: number;
  window: PeriodWindow;
  /** Every customer order existing at asOf, newest due date last. Includes cancelled orders (status says so). */
  orders: OrderDispatchView[];
  /** On-Time In-Full Dispatch over the due-date cohort. */
  onTimeInFull: Rate;
  /** Quantity Fill by Due Date over the same cohort (units). */
  quantityFill: Rate;
  /** On-Time Dispatch Rate: shipments dispatched in the window that left on or before their order's due date. */
  onTimeDispatch: Rate;
  /** Past-Due Unshipped Orders at asOf (not windowed: a fact about now), most overdue first. */
  pastDue: { count: number; partiallyDispatched: number; unshippedQuantity: number; orders: OrderDispatchView[] };
  /** Order-to-Final-Dispatch Lead Time over orders whose final dispatch falls in the window. */
  leadTime: { count: number; medianMs: number | null; p90Ms: number | null; openOrders: number };
  /** Non-cancelled orders with status SHIPPED whose final dispatch could not be derived (excluded from the cohort). */
  indeterminate: number;
  /** Cancelled orders whose due date falls in the cohort window; excluded from every rate. */
  cancelledInWindow: number;
  cohortSize: number;
}

const isOpen = (o: Pick<CustomerOrder, "status">) => o.status === "OPEN" || o.status === "PARTIALLY_SHIPPED";

/** Nearest-rank percentile of an ascending array; null when empty. */
export function nearestRank(sortedAsc: readonly number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const rank = Math.max(1, Math.ceil(p * sortedAsc.length));
  return sortedAsc[rank - 1];
}

const rate = (numerator: number, denominator: number): Rate => ({
  numerator,
  denominator,
  rate: denominator === 0 ? null : numerator / denominator,
});

/** Shipments of each customer order, ordered by (dispatchedAt, id). */
function shipmentsByOrder(shipments: Record<Id, Shipment>): Map<Id, Shipment[]> {
  const map = new Map<Id, Shipment[]>();
  for (const s of Object.values(shipments)) {
    const list = map.get(s.customerOrderId);
    if (list) list.push(s);
    else map.set(s.customerOrderId, [s]);
  }
  for (const list of map.values()) list.sort((a, b) => Date.parse(a.dispatchedAt) - Date.parse(b.dispatchedAt) || a.id.localeCompare(b.id));
  return map;
}

/** Earliest FINISHED_GOODS_ALLOCATED per customer order, from the applied events. */
function firstAllocations(events: readonly FactoryEvent[], asOfMs: number): Map<Id, number> {
  const map = new Map<Id, number>();
  for (const e of events) {
    if (e.type !== "FINISHED_GOODS_ALLOCATED") continue;
    const ms = Date.parse(e.timestamp);
    if (ms > asOfMs) continue;
    const id = e.payload.customerOrderId;
    const prev = map.get(id);
    if (prev === undefined || ms < prev) map.set(id, ms);
  }
  return map;
}

/** The dispatch instant after which every line of the order is fully shipped, or null if the shipments never complete it. */
function finalDispatchOf(order: CustomerOrder, shipments: readonly Shipment[]): number | null {
  const remaining = new Map(order.lines.map((l) => [l.id, l.quantity]));
  for (const s of shipments) {
    for (const sl of s.lines) remaining.set(sl.customerOrderLineId, (remaining.get(sl.customerOrderLineId) ?? 0) - sl.quantity);
    if ([...remaining.values()].every((r) => r === 0)) return Date.parse(s.dispatchedAt);
  }
  return null;
}

export function dispatchReport(snapshot: ReportingSnapshot, period: PeriodId): DispatchReport {
  const { state, master, asOfMs, startMs } = snapshot;
  const window = periodWindow(period, asOfMs, startMs);
  const byOrder = shipmentsByOrder(state.shipments);
  const allocations = firstAllocations(snapshot.events, asOfMs);
  const customerName = new Map(master.customers.map((c) => [c.id, c.name]));

  const lineToOrder = new Map<Id, Id>();
  for (const o of Object.values(state.customerOrders)) for (const l of o.lines) lineToOrder.set(l.id, o.id);
  const plannedBy = new Map<Id, Set<Id>>();
  for (const wo of Object.values(state.productionOrders)) {
    for (const lineId of wo.demandLineIds) {
      const orderId = lineToOrder.get(lineId);
      if (!orderId) continue;
      const set = plannedBy.get(orderId) ?? new Set<Id>();
      set.add(wo.id);
      plannedBy.set(orderId, set);
    }
  }

  const orders: OrderDispatchView[] = Object.values(state.customerOrders)
    .filter((o) => Date.parse(o.createdAt) <= asOfMs)
    .map((o) => {
      const ships = (byOrder.get(o.id) ?? []).filter((s) => Date.parse(s.dispatchedAt) <= asOfMs);
      const createdAtMs = Date.parse(o.createdAt);
      const dueMs = Date.parse(o.dueDate);
      const orderedQuantity = o.lines.reduce((n, l) => n + l.quantity, 0);
      const shippedQuantity = o.lines.reduce((n, l) => n + l.shippedQuantity, 0);
      const firstDispatchMs = ships.length ? Date.parse(ships[0].dispatchedAt) : null;
      const finalDispatchMs = o.status === "SHIPPED" ? finalDispatchOf(o, ships) : null;
      const firstAllocationMs = allocations.get(o.id) ?? null;
      const leadTimeMs = finalDispatchMs === null ? null : finalDispatchMs - createdAtMs;
      let segments: LeadTimeSegments | null = null;
      if (finalDispatchMs !== null && firstDispatchMs !== null && firstAllocationMs !== null) {
        const ordered = createdAtMs <= firstAllocationMs && firstAllocationMs <= firstDispatchMs && firstDispatchMs <= finalDispatchMs;
        if (ordered) {
          segments = {
            toFirstAllocationMs: firstAllocationMs - createdAtMs,
            allocationToFirstDispatchMs: firstDispatchMs - firstAllocationMs,
            firstToFinalDispatchMs: finalDispatchMs - firstDispatchMs,
          };
        }
      }
      const open = isOpen(o);
      return {
        orderId: o.id,
        customerId: o.customerId,
        customerName: customerName.get(o.customerId) ?? o.customerId,
        status: o.status,
        createdAtMs,
        dueMs,
        orderedQuantity,
        shippedQuantity,
        unshippedQuantity: orderedQuantity - shippedQuantity,
        shipmentCount: ships.length,
        firstAllocationMs,
        firstDispatchMs,
        finalDispatchMs,
        leadTimeMs,
        segments,
        latenessMs: finalDispatchMs === null ? null : Math.max(0, finalDispatchMs - dueMs),
        pastDueMs: open && dueMs <= asOfMs ? asOfMs - dueMs : null,
        timeToDueMs: open && dueMs > asOfMs ? dueMs - asOfMs : null,
        partiallyDispatched: o.status === "PARTIALLY_SHIPPED",
        plannedWorkOrderIds: [...(plannedBy.get(o.id) ?? [])].sort(),
      };
    })
    .sort((a, b) => a.dueMs - b.dueMs || a.orderId.localeCompare(b.orderId));

  // Due-date cohort: non-cancelled orders due inside the window and already due.
  const inCohortWindow = (o: OrderDispatchView) => inWindow(o.dueMs, window) && o.dueMs <= asOfMs;
  const cohort = orders.filter((o) => o.status !== "CANCELLED" && inCohortWindow(o));
  const indeterminate = cohort.filter((o) => o.status === "SHIPPED" && o.finalDispatchMs === null).length;
  const decided = cohort.filter((o) => !(o.status === "SHIPPED" && o.finalDispatchMs === null));
  const onTimeInFull = rate(decided.filter((o) => o.finalDispatchMs !== null && o.finalDispatchMs <= o.dueMs).length, decided.length);

  // Quantity Fill by Due Date: units dispatched on or before the due date over units ordered, same cohort.
  const decidedIds = new Set(decided.map((o) => o.orderId));
  let ordered = 0;
  let byDue = 0;
  for (const o of decided) ordered += o.orderedQuantity;
  for (const s of Object.values(state.shipments)) {
    if (!decidedIds.has(s.customerOrderId)) continue;
    const due = Date.parse(state.customerOrders[s.customerOrderId].dueDate);
    const at = Date.parse(s.dispatchedAt);
    if (at <= due && at <= asOfMs) for (const l of s.lines) byDue += l.quantity;
  }
  const quantityFill = rate(byDue, ordered);

  // On-Time Dispatch Rate: shipments dispatched in the window, non-cancelled orders.
  let shipOnTime = 0;
  let shipTotal = 0;
  for (const s of Object.values(state.shipments)) {
    const order = state.customerOrders[s.customerOrderId];
    const at = Date.parse(s.dispatchedAt);
    if (!order || order.status === "CANCELLED" || !inWindow(at, window)) continue;
    shipTotal++;
    if (at <= Date.parse(order.dueDate)) shipOnTime++;
  }
  const onTimeDispatch = rate(shipOnTime, shipTotal);

  const pastDueOrders = orders.filter((o) => o.pastDueMs !== null).sort((a, b) => b.pastDueMs! - a.pastDueMs! || a.orderId.localeCompare(b.orderId));

  const leadTimes = orders
    .filter((o) => o.leadTimeMs !== null && inWindow(o.finalDispatchMs!, window))
    .map((o) => o.leadTimeMs!)
    .sort((a, b) => a - b);

  return {
    asOfMs,
    window,
    orders,
    onTimeInFull,
    quantityFill,
    onTimeDispatch,
    pastDue: {
      count: pastDueOrders.length,
      partiallyDispatched: pastDueOrders.filter((o) => o.partiallyDispatched).length,
      unshippedQuantity: pastDueOrders.reduce((n, o) => n + o.unshippedQuantity, 0),
      orders: pastDueOrders,
    },
    leadTime: {
      count: leadTimes.length,
      medianMs: nearestRank(leadTimes, 0.5),
      p90Ms: nearestRank(leadTimes, 0.9),
      openOrders: orders.filter((o) => isOpen({ status: o.status })).length,
    },
    indeterminate,
    cancelledInWindow: orders.filter((o) => o.status === "CANCELLED" && inCohortWindow(o)).length,
    cohortSize: decided.length,
  };
}
