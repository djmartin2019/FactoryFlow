import { describe, expect, it } from "vitest";
import { dispatchReport, nearestRank, type ReportingSnapshot } from "../src/analytics/index.ts";
import { DAY, HOUR } from "../src/manufacturing/calendar.ts";
import { generateDataset } from "../src/manufacturing/generator.ts";
import { buildEvent } from "../src/manufacturing/events.ts";
import type {
  CustomerOrder,
  FactoryEvent,
  InitialStateFile,
  ManufacturingDataset,
  ProductionOrder,
  Shipment,
} from "../src/manufacturing/types.ts";
import { endSnapshot, initialFileOf, literalSnapshot } from "./helpers/snapshot.ts";

// Built at module load: several describe blocks construct fixtures while collecting.
const data: ManufacturingDataset = generateDataset();
const initial: InitialStateFile = initialFileOf(data);

const T0 = Date.parse("2026-09-01T00:00:00.000Z");
const at = (days: number, hours = 0) => T0 + days * DAY + hours * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

interface OrderSpec {
  id: string;
  createdMs: number;
  dueMs: number;
  lines: Array<{ id: string; quantity: number; shipped?: number }>;
  status: CustomerOrder["status"];
}

function order(spec: OrderSpec): CustomerOrder {
  return {
    id: spec.id,
    customerId: initial.master.customers[0].id,
    createdAt: iso(spec.createdMs),
    dueDate: iso(spec.dueMs),
    status: spec.status,
    demandDriver: "BASELINE",
    lines: spec.lines.map((l, i) => ({
      id: l.id,
      lineNumber: i + 1,
      productId: initial.master.products[0].id,
      quantity: l.quantity,
      allocatedQuantity: 0,
      shippedQuantity: l.shipped ?? 0,
      unitPriceCents: 100,
    })),
  };
}

function shipment(id: string, orderId: string, ms: number, lines: Array<[string, number]>): Shipment {
  return {
    id,
    customerOrderId: orderId,
    customerId: initial.master.customers[0].id,
    dispatchedAt: iso(ms),
    carrier: "TEST",
    lines: lines.map(([lineId, quantity], i) => ({
      id: `${id}-L${i}`,
      customerOrderLineId: lineId,
      productId: initial.master.products[0].id,
      quantity,
      fromLocationId: "FG",
    })),
  };
}

function allocation(seq: number, orderId: string, lineId: string, ms: number): FactoryEvent {
  return buildEvent(seq, iso(ms), "FINISHED_GOODS_ALLOCATED", {
    allocationId: `AL-${seq}`,
    customerOrderId: orderId,
    customerOrderLineId: lineId,
    productId: initial.master.products[0].id,
    quantity: 1,
    locationId: "FG",
  });
}

function snap(
  asOfMs: number,
  orders: CustomerOrder[],
  shipments: Shipment[] = [],
  events: FactoryEvent[] = [],
  productionOrders: ProductionOrder[] = [],
): ReportingSnapshot {
  const state = {
    ...initial.state,
    customerOrders: Object.fromEntries(orders.map((o) => [o.id, o])),
    shipments: Object.fromEntries(shipments.map((s) => [s.id, s])),
    productionOrders: Object.fromEntries(productionOrders.map((p) => [p.id, p])),
  };
  return literalSnapshot(initial, { asOfMs, events, state, startMs: T0 });
}

const report = (s: ReportingSnapshot) => dispatchReport(s, "all");
const view = (r: ReturnType<typeof report>, id: string) => r.orders.find((o) => o.orderId === id)!;

describe("Order-to-Final-Dispatch Lead Time and segments", () => {
  const o = order({ id: "CO-1", createdMs: at(0, 8), dueMs: at(3), lines: [{ id: "CO-1-1", quantity: 10, shipped: 10 }], status: "SHIPPED" });
  const s = snap(at(5), [o], [shipment("SH-1", "CO-1", at(1, 9), [["CO-1-1", 10]])], [allocation(1, "CO-1", "CO-1-1", at(0, 10))]);
  const v = view(report(s), "CO-1");

  it("measures created to the completing shipment", () => {
    expect(v.finalDispatchMs).toBe(at(1, 9));
    expect(v.leadTimeMs).toBe(at(1, 9) - at(0, 8));
  });

  it("splits the lead time into three consecutive segments that sum exactly", () => {
    expect(v.segments).toEqual({ toFirstAllocationMs: 2 * HOUR, allocationToFirstDispatchMs: 23 * HOUR, firstToFinalDispatchMs: 0 });
    const seg = v.segments!;
    expect(seg.toFirstAllocationMs + seg.allocationToFirstDispatchMs + seg.firstToFinalDispatchMs).toBe(v.leadTimeMs);
  });

  it("has zero lateness when dispatched before the due date", () => {
    expect(v.latenessMs).toBe(0);
  });

  it("leaves segments unavailable, not zero, when the order has no allocation event", () => {
    const none = view(report(snap(at(5), [o], [shipment("SH-1", "CO-1", at(1, 9), [["CO-1-1", 10]])])), "CO-1");
    expect(none.segments).toBeNull();
    expect(none.leadTimeMs).toBe(at(1, 9) - at(0, 8));
  });
});

describe("On-Time In-Full Dispatch", () => {
  it("counts a dispatch exactly on the due instant as on time", () => {
    const o = order({ id: "CO-1", createdMs: at(0), dueMs: at(2), lines: [{ id: "L1", quantity: 4, shipped: 4 }], status: "SHIPPED" });
    const r = report(snap(at(5), [o], [shipment("S1", "CO-1", at(2), [["L1", 4]])]));
    expect(r.onTimeInFull).toEqual({ numerator: 1, denominator: 1, rate: 1 });
    expect(view(r, "CO-1").latenessMs).toBe(0);
  });

  it("reports lateness in ms for a late dispatch", () => {
    const o = order({ id: "CO-1", createdMs: at(0), dueMs: at(2), lines: [{ id: "L1", quantity: 4, shipped: 4 }], status: "SHIPPED" });
    const r = report(snap(at(5), [o], [shipment("S1", "CO-1", at(2, 5), [["L1", 4]])]));
    expect(view(r, "CO-1").latenessMs).toBe(5 * HOUR);
    expect(r.onTimeInFull.numerator).toBe(0);
  });

  it("does not count a partial dispatch by the due date as in full, but credits it to Quantity Fill", () => {
    const o = order({ id: "CO-1", createdMs: at(0), dueMs: at(2), lines: [{ id: "L1", quantity: 10, shipped: 10 }], status: "SHIPPED" });
    const ships = [shipment("S1", "CO-1", at(1), [["L1", 6]]), shipment("S2", "CO-1", at(3), [["L1", 4]])];
    const r = report(snap(at(5), [o], ships, [allocation(1, "CO-1", "L1", at(0, 1))]));
    expect(r.onTimeInFull).toEqual({ numerator: 0, denominator: 1, rate: 0 });
    expect(r.quantityFill).toEqual({ numerator: 6, denominator: 10, rate: 0.6 });
    // Shipment-level rate counts each shipment once: the first left on time, the balance did not.
    expect(r.onTimeDispatch).toEqual({ numerator: 1, denominator: 2, rate: 0.5 });
    const v = view(r, "CO-1");
    expect(v.finalDispatchMs).toBe(at(3));
    expect(v.segments!.firstToFinalDispatchMs).toBe(2 * DAY);
    const seg = v.segments!;
    expect(seg.toFirstAllocationMs + seg.allocationToFirstDispatchMs + seg.firstToFinalDispatchMs).toBe(v.leadTimeMs);
  });

  it("keeps an unshipped overdue order in the denominator and lists it as past due", () => {
    const late = order({ id: "CO-1", createdMs: at(0), dueMs: at(2), lines: [{ id: "L1", quantity: 5 }], status: "OPEN" });
    const good = order({ id: "CO-2", createdMs: at(0), dueMs: at(2), lines: [{ id: "L2", quantity: 5, shipped: 5 }], status: "SHIPPED" });
    const r = report(snap(at(4), [late, good], [shipment("S2", "CO-2", at(1), [["L2", 5]])]));
    expect(r.onTimeInFull).toEqual({ numerator: 1, denominator: 2, rate: 0.5 });
    expect(r.pastDue.count).toBe(1);
    expect(r.pastDue.orders[0].orderId).toBe("CO-1");
    expect(r.pastDue.orders[0].pastDueMs).toBe(2 * DAY);
    expect(r.pastDue.unshippedQuantity).toBe(5);
    expect(view(r, "CO-1").latenessMs).toBeNull();
    expect(view(r, "CO-1").leadTimeMs).toBeNull();
  });

  it("flags partially dispatched past-due orders", () => {
    const o = order({ id: "CO-1", createdMs: at(0), dueMs: at(1), lines: [{ id: "L1", quantity: 10, shipped: 4 }], status: "PARTIALLY_SHIPPED" });
    const r = report(snap(at(3), [o], [shipment("S1", "CO-1", at(1), [["L1", 4]])]));
    expect(r.pastDue).toMatchObject({ count: 1, partiallyDispatched: 1, unshippedQuantity: 6 });
    expect(r.onTimeInFull).toEqual({ numerator: 0, denominator: 1, rate: 0 });
  });

  it("excludes open orders that are not yet due from the cohort and gives them a time to due date", () => {
    const o = order({ id: "CO-1", createdMs: at(0), dueMs: at(10), lines: [{ id: "L1", quantity: 5 }], status: "OPEN" });
    const r = report(snap(at(4), [o]));
    expect(r.cohortSize).toBe(0);
    expect(view(r, "CO-1").timeToDueMs).toBe(6 * DAY);
    expect(view(r, "CO-1").pastDueMs).toBeNull();
    expect(r.pastDue.count).toBe(0);
  });

  it("excludes cancelled orders from every rate and counts them separately", () => {
    const c = order({ id: "CO-9", createdMs: at(0), dueMs: at(1), lines: [{ id: "L9", quantity: 3 }], status: "CANCELLED" });
    const r = report(snap(at(4), [c]));
    expect(r.cohortSize).toBe(0);
    expect(r.cancelledInWindow).toBe(1);
    expect(r.pastDue.count).toBe(0);
  });

  it("returns N/A (null), not 0, for an empty cohort", () => {
    const r = report(snap(at(4), []));
    expect(r.onTimeInFull.rate).toBeNull();
    expect(r.quantityFill.rate).toBeNull();
    expect(r.onTimeDispatch.rate).toBeNull();
    expect(r.leadTime).toMatchObject({ count: 0, medianMs: null, p90Ms: null });
  });

  it("excludes SHIPPED orders whose final dispatch cannot be derived and reports them", () => {
    const o = order({ id: "CO-1", createdMs: at(0), dueMs: at(1), lines: [{ id: "L1", quantity: 5, shipped: 5 }], status: "SHIPPED" });
    const r = report(snap(at(4), [o]));
    expect(r.indeterminate).toBe(1);
    expect(r.cohortSize).toBe(0);
    expect(view(r, "CO-1").leadTimeMs).toBeNull();
  });

  it("applies the reporting window to the due-date cohort and to lead-time statistics", () => {
    const old = order({ id: "CO-1", createdMs: at(0), dueMs: at(2), lines: [{ id: "L1", quantity: 1, shipped: 1 }], status: "SHIPPED" });
    const recent = order({ id: "CO-2", createdMs: at(8), dueMs: at(10), lines: [{ id: "L2", quantity: 1, shipped: 1 }], status: "SHIPPED" });
    const s = snap(at(10, 6), [old, recent], [shipment("S1", "CO-1", at(1), [["L1", 1]]), shipment("S2", "CO-2", at(9), [["L2", 1]])]);
    const all = dispatchReport(s, "all");
    const week = dispatchReport(s, "7d");
    expect(all.cohortSize).toBe(2);
    expect(week.cohortSize).toBe(1);
    expect(week.leadTime.count).toBe(1);
    expect(week.leadTime.medianMs).toBe(DAY);
  });
});

describe("planning link", () => {
  it("lists work orders planned to satisfy an order's lines without claiming unit flow", () => {
    const o = order({ id: "CO-1", createdMs: at(0), dueMs: at(5), lines: [{ id: "L1", quantity: 5 }], status: "OPEN" });
    const wo = { ...Object.values(initial.state.productionOrders)[0], id: "WO-X", demandLineIds: ["L1"] } as ProductionOrder;
    const r = report(snap(at(2), [o], [], [], [wo]));
    expect(view(r, "CO-1").plannedWorkOrderIds).toEqual(["WO-X"]);
  });
});

describe("percentiles", () => {
  it("uses nearest rank", () => {
    expect(nearestRank([], 0.5)).toBeNull();
    expect(nearestRank([5], 0.9)).toBe(5);
    expect(nearestRank([1, 2, 3, 4], 0.5)).toBe(2);
    expect(nearestRank([1, 2, 3, 4], 0.9)).toBe(4);
    expect(nearestRank(Array.from({ length: 10 }, (_, i) => i + 1), 0.9)).toBe(9);
  });
});

describe("default dataset", () => {
  it("satisfies the S1a identities on real replayed state", () => {
    const s = endSnapshot(initial, data.events);
    const r = dispatchReport(s, "all");
    expect(r.orders.length).toBeGreaterThan(0);
    for (const v of r.orders) {
      if (v.leadTimeMs !== null && v.segments) {
        const g = v.segments;
        expect(g.toFirstAllocationMs + g.allocationToFirstDispatchMs + g.firstToFinalDispatchMs, v.orderId).toBe(v.leadTimeMs);
      }
      if (v.status === "SHIPPED") {
        expect(v.finalDispatchMs, v.orderId).not.toBeNull();
        expect(v.leadTimeMs!, v.orderId).toBeGreaterThanOrEqual(0);
      } else {
        expect(v.leadTimeMs, v.orderId).toBeNull();
        expect(v.latenessMs, v.orderId).toBeNull();
      }
      expect(v.unshippedQuantity).toBe(v.orderedQuantity - v.shippedQuantity);
    }
    for (const rt of [r.onTimeInFull, r.quantityFill, r.onTimeDispatch]) {
      expect(rt.numerator).toBeLessThanOrEqual(rt.denominator);
      if (rt.rate !== null) expect(rt.rate).toBeGreaterThanOrEqual(0);
      if (rt.rate !== null) expect(rt.rate).toBeLessThanOrEqual(1);
    }
    expect(r.indeterminate).toBe(0);
    expect(r.pastDue.orders.every((o) => o.status === "OPEN" || o.status === "PARTIALLY_SHIPPED")).toBe(true);
  });

  it("is deterministic and does not mutate the snapshot", () => {
    const s = endSnapshot(initial, data.events);
    const before = JSON.stringify(s.state.customerOrders) + JSON.stringify(s.state.shipments);
    const a = dispatchReport(s, "7d");
    const b = dispatchReport(s, "7d");
    expect(b).toEqual(a);
    expect(JSON.stringify(s.state.customerOrders) + JSON.stringify(s.state.shipments)).toBe(before);
  });
});
