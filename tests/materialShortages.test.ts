import { describe, expect, it } from "vitest";
import { materialShortages, periodWindow, type ReportingSnapshot } from "../src/analytics/index.ts";
import { DAY, HOUR } from "../src/manufacturing/calendar.ts";
import { computeKpis } from "../src/manufacturing/dashboardMetrics.ts";
import { generateDataset } from "../src/manufacturing/generator.ts";
import { FactoryReplay } from "../src/manufacturing/replay.ts";
import type { FactoryState, InitialStateFile, PurchaseOrder } from "../src/manufacturing/types.ts";
import { initialFileOf, snapshotAt } from "./helpers/snapshot.ts";

const data = generateDataset();
const initial: InitialStateFile = initialFileOf(data);
const START = Date.parse(initial.state.asOf);
// First hour of the default dataset (seed northstar-2026) with a work order blocked on material; the scan test guards this.
const BLOCKED_AT = Date.parse("2026-09-07T10:00:00.000Z");

const base = snapshotAt(initial, data.events, BLOCKED_AT);
const report = materialShortages(base);
const target = report.blockedOrders.find((o) => o.lines.length > 0)!;
const line = target.lines[0];

/** The same snapshot with the purchase orders for one material replaced by `pos`. */
function withSupply(materialId: string, pos: Array<{ id: string; promisedMs: number; ordered: number; received: number; status?: PurchaseOrder["status"] }>): ReportingSnapshot {
  const template = Object.values(base.state.purchaseOrders)[0];
  const state = structuredClone(base.state) as FactoryState;
  state.purchaseOrders = Object.fromEntries(
    Object.entries(state.purchaseOrders).filter(([, po]) => !po.lines.some((l) => l.materialId === materialId)),
  );
  for (const p of pos) {
    state.purchaseOrders[p.id] = {
      ...structuredClone(template),
      id: p.id,
      promisedDeliveryAt: new Date(p.promisedMs).toISOString(),
      status: p.status ?? "OPEN",
      lines: [{ id: `${p.id}-1`, lineNumber: 1, materialId, orderedQuantity: p.ordered, receivedQuantity: p.received, unitCostCents: 1 }],
    };
  }
  return { ...base, state };
}

const lineOf = (s: ReportingSnapshot) => materialShortages(s).blockedOrders.find((o) => o.orderId === target.orderId)!.lines.find((l) => l.materialId === line.materialId)!;

describe("material shortage impact", () => {
  it("has a blocked order with a shortage to work with", () => {
    expect(report.blockedOrders.length).toBeGreaterThan(0);
    expect(line.shortfall).toBeGreaterThan(0);
  });

  it("states required, available now and the shortfall from the BOM and current balances", () => {
    const bom = base.master.billsOfMaterials.find((b) => b.productId === target.productId)!;
    const per = bom.lines.find((l) => l.materialId === line.materialId)!.quantityPer;
    expect(line.required).toBe(per * target.quantity);
    expect(line.shortfall).toBe(line.required - line.availableNow);
    const raw = new Set(base.master.locations.filter((l) => l.kind === "RAW_STORAGE").map((l) => l.id));
    const avail = Object.values(base.state.inventory)
      .filter((b) => b.itemId === line.materialId && raw.has(b.locationId))
      .reduce((n, b) => n + b.onHand - b.reserved, 0);
    expect(line.availableNow).toBe(avail);
  });

  it("says 'no supply' when no open purchase-order quantity exists", () => {
    const l = lineOf(withSupply(line.materialId, []));
    expect(l.supply).toMatchObject({ status: "NO_SUPPLY", outstandingQuantity: 0, coverDateMs: null, purchaseOrderIds: [], overdue: false });
  });

  it("ignores received purchase orders and fully received lines", () => {
    const s = withSupply(line.materialId, [
      { id: "PO-R1", promisedMs: BLOCKED_AT + DAY, ordered: 9999, received: 9999, status: "RECEIVED" },
      { id: "PO-R2", promisedMs: BLOCKED_AT + DAY, ordered: 500, received: 500, status: "PARTIALLY_RECEIVED" },
    ]);
    expect(lineOf(s).supply.status).toBe("NO_SUPPLY");
  });

  it("says 'not covered' when open supply is smaller than the shortfall, and lists what is on order", () => {
    const s = withSupply(line.materialId, [{ id: "PO-S", promisedMs: BLOCKED_AT + 2 * DAY, ordered: line.shortfall - 1, received: 0 }]);
    expect(lineOf(s).supply).toMatchObject({ status: "NOT_COVERED", outstandingQuantity: line.shortfall - 1, coverDateMs: null, purchaseOrderIds: ["PO-S"] });
  });

  it("finds the promised date at which cumulative outstanding supply first covers the shortfall", () => {
    const half = Math.ceil(line.shortfall / 2);
    const s = withSupply(line.materialId, [
      { id: "PO-B", promisedMs: BLOCKED_AT + 5 * DAY, ordered: line.shortfall, received: 0 },
      { id: "PO-A", promisedMs: BLOCKED_AT + 2 * DAY, ordered: half, received: 0 },
      { id: "PO-C", promisedMs: BLOCKED_AT + 9 * DAY, ordered: 1000, received: 0 },
    ]);
    const l = lineOf(s);
    // PO-A alone is short (half < shortfall when shortfall > 1); with PO-B cumulative reaches the shortfall on day 5.
    expect(l.supply.status).toBe("COVERED");
    expect(l.supply.coverDateMs).toBe(half >= line.shortfall ? BLOCKED_AT + 2 * DAY : BLOCKED_AT + 5 * DAY);
    expect(l.supply.purchaseOrderIds).toEqual(half >= line.shortfall ? ["PO-A"] : ["PO-A", "PO-B"]);
    expect(l.supply.outstandingQuantity).toBe(half + line.shortfall + 1000);
  });

  it("counts a partly received line by its outstanding quantity only", () => {
    const s = withSupply(line.materialId, [{ id: "PO-P", promisedMs: BLOCKED_AT + DAY, ordered: line.shortfall + 40, received: 40, status: "PARTIALLY_RECEIVED" }]);
    expect(lineOf(s).supply).toMatchObject({ status: "COVERED", outstandingQuantity: line.shortfall });
  });

  it("flags supply whose promised date has already passed", () => {
    const late = lineOf(withSupply(line.materialId, [{ id: "PO-L", promisedMs: BLOCKED_AT - 2 * DAY, ordered: line.shortfall, received: 0 }]));
    expect(late.supply).toMatchObject({ status: "COVERED", overdue: true });
    const onTime = lineOf(withSupply(line.materialId, [{ id: "PO-F", promisedMs: BLOCKED_AT + 2 * DAY, ordered: line.shortfall, received: 0 }]));
    expect(onTime.supply.overdue).toBe(false);
  });

  it("summarizes per material without adding the orders' shortfalls together", () => {
    const rows = report.byMaterial;
    expect(rows.reduce((n, r) => n + r.blockedOrders, 0)).toBe(report.blockedOrders.reduce((n, o) => n + o.lines.length, 0));
    for (const r of rows) {
      expect(Object.keys(r)).not.toContain("totalShortfall");
      expect(r.overduePurchaseOrders).toBeLessThanOrEqual(r.openPurchaseOrders);
    }
  });

  it("links each blocked work order to the customer orders it was planned for", () => {
    for (const o of report.blockedOrders) {
      const wo = base.state.productionOrders[o.orderId];
      const expected = new Set(
        Object.values(base.state.customerOrders)
          .filter((c) => c.lines.some((l) => wo.demandLineIds.includes(l.id)))
          .map((c) => c.id),
      );
      expect(new Set(o.customerOrderIds)).toEqual(expected);
      if (expected.size === 0) expect(o.earliestCustomerDueMs).toBeNull();
    }
  });
});

describe("material shortage impact over the run", () => {
  it("lists exactly the orders counted by the dashboard 'Blocked by material shortage' KPI, at every sampled time", () => {
    const r = new FactoryReplay(structuredClone(initial), data.events);
    let withBlocked = 0;
    for (let h = 6; h < 30 * 24; h += 6) {
      const ms = START + h * HOUR;
      r.advanceToMs(ms);
      const s: ReportingSnapshot = { asOfMs: ms, startMs: START, master: initial.master, state: r.state, events: [] };
      const rep = materialShortages(s);
      const kpi = computeKpis(s.state, s.master, periodWindow("all", ms, START)).shortageBlocked;
      expect(rep.blockedOrders.length, new Date(ms).toISOString()).toBe(kpi.value);
      for (const o of rep.blockedOrders) {
        expect(s.state.productionOrders[o.orderId].blockReason).toBe("MATERIAL_SHORTAGE");
        for (const l of o.lines) {
          expect(l.shortfall).toBeGreaterThan(0);
          expect(l.shortfall).toBe(l.required - l.availableNow);
        }
      }
      if (rep.blockedOrders.length) withBlocked++;
    }
    expect(withBlocked).toBeGreaterThan(10);
  });

  it("is deterministic and does not mutate the snapshot", () => {
    const before = JSON.stringify(base.state.purchaseOrders) + JSON.stringify(base.state.inventory);
    expect(materialShortages(base)).toEqual(materialShortages(base));
    expect(JSON.stringify(base.state.purchaseOrders) + JSON.stringify(base.state.inventory)).toBe(before);
  });
});
