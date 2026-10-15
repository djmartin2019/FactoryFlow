import { beforeAll, describe, expect, it } from "vitest";
import {
  categoryOf,
  goodUnitsThroughput,
  granularityFor,
  inWindow,
  periodWindow,
  workOrderCounts,
  workOrderDetail,
  workOrderSummaries,
  workOrderTimeline,
  type ReportingSnapshot,
} from "../src/analytics/index.ts";
import { DAY, HOUR } from "../src/manufacturing/calendar.ts";
import { computeKpis } from "../src/manufacturing/dashboardMetrics.ts";
import { generateDataset } from "../src/manufacturing/generator.ts";
import { FactoryReplay } from "../src/manufacturing/replay.ts";
import type { FactoryEvent, ManufacturingDataset } from "../src/manufacturing/types.ts";
import { reportingSnapshot } from "../src/simulation/reportingSnapshot.ts";
import { SimulationController } from "../src/simulation/SimulationController.ts";

let data: ManufacturingDataset;
const initialFile = () => ({ schemaVersion: "1.0.0", master: data.master, state: data.initialState });
const startMs = () => Date.parse(data.initialState.asOf);
const endMs = () => Date.parse(data.finalState.asOf);
const newSim = () => new SimulationController(structuredClone(initialFile()), data.events);

beforeAll(() => {
  data = generateDataset();
});

function snapshotAt(ms: number): ReportingSnapshot {
  const r = new FactoryReplay(initialFile(), data.events);
  r.advanceToMs(ms);
  return { asOfMs: ms, startMs: startMs(), master: data.master, state: r.state, events: r.appliedEvents() };
}

describe("work order status", () => {
  it("maps domain status onto reporting categories", () => {
    expect(categoryOf({ status: "PLANNED" })).toBe("OPEN");
    expect(categoryOf({ status: "WAITING" })).toBe("OPEN");
    expect(categoryOf({ status: "BLOCKED" })).toBe("OPEN");
    expect(categoryOf({ status: "BLOCKED", startedAt: "2026-09-02T08:00:00.000Z" })).toBe("IN_PROGRESS");
    expect(categoryOf({ status: "RUNNING" })).toBe("IN_PROGRESS");
    expect(categoryOf({ status: "COMPLETED" })).toBe("COMPLETED");
    expect(categoryOf({ status: "CANCELLED" })).toBe("CANCELLED");
  });

  it("counts partition the orders that exist at the timestamp", () => {
    for (const frac of [0, 0.1, 0.5, 1]) {
      const t = startMs() + frac * (endMs() - startMs());
      const snap = snapshotAt(t);
      const s = workOrderSummaries(snap);
      const c = workOrderCounts(s);
      expect(c.total).toBe(Object.keys(snap.state.productionOrders).length);
      expect(c.open + c.inProgress + c.completed + c.cancelled).toBe(c.total);
      expect(c.completed).toBe(Object.values(snap.state.productionOrders).filter((o) => o.status === "COMPLETED").length);
      expect(s.every((o) => o.createdAtMs <= t)).toBe(true);
    }
  });
});

describe("good-unit aggregation", () => {
  it("matches the dashboard KPI for every period at several timestamps", () => {
    for (const frac of [0.2, 0.5, 0.8, 1]) {
      const t = startMs() + frac * (endMs() - startMs());
      const snap = snapshotAt(t);
      for (const period of ["24h", "7d", "all"] as const) {
        const kpi = computeKpis(snap.state, data.master, periodWindow(period, t, startMs())).goodUnits.value;
        expect(goodUnitsThroughput(snap, period).total).toBe(kpi);
      }
    }
  });

  it("per-product series sum to the all-product series and buckets sum to the total", () => {
    const snap = snapshotAt(endMs());
    const all = goodUnitsThroughput(snap, "all");
    expect(all.total).toBe(Object.values(snap.state.productionOrders).reduce((a, o) => a + o.finishedGoodsReceivedQuantity, 0));
    expect(all.points.reduce((a, p) => a + p.units, 0)).toBe(all.total);
    const per = data.master.products.map((p) => goodUnitsThroughput(snap, "all", p.id).total);
    expect(per.reduce((a, b) => a + b, 0)).toBe(all.total);
  });

  it("is empty before any production", () => {
    const s = goodUnitsThroughput(snapshotAt(startMs()), "24h");
    expect(s.total).toBe(0);
    expect(s.points.length).toBeGreaterThan(0);
  });
});

describe("reporting window boundaries", () => {
  const now = Date.parse("2026-09-10T12:00:00.000Z");
  const fg = (seq: number, ts: string, quantity: number): FactoryEvent =>
    ({
      id: `EVT-${seq}`,
      sequence: seq,
      timestamp: ts,
      type: "FINISHED_GOODS_RECEIVED",
      entities: {},
      payload: { productionOrderId: "WO-X", productId: "NCP-100", quantity, locationId: "L" },
    }) as unknown as FactoryEvent;

  it("windows are (from, to]", () => {
    const win = { fromMs: 100, toMs: 200 };
    expect(inWindow(100, win)).toBe(false);
    expect(inWindow(101, win)).toBe(true);
    expect(inWindow(200, win)).toBe(true);
    expect(inWindow(201, win)).toBe(false);
  });

  it("includes an event at `now`, excludes one at the window start and after now", () => {
    const from = now - DAY;
    const snap: ReportingSnapshot = {
      asOfMs: now,
      startMs: now - 10 * DAY,
      master: data.master,
      state: data.initialState,
      events: [
        fg(1, new Date(from).toISOString(), 5), // exactly at window start: excluded
        fg(2, new Date(from + 1).toISOString(), 3),
        fg(3, new Date(now).toISOString(), 2), // exactly now: included
        fg(4, new Date(now + 1).toISOString(), 100), // future: excluded
      ],
    };
    const s = goodUnitsThroughput(snap, "24h");
    expect(s.total).toBe(5);
    expect(s.granularity).toBe("hour");
    expect(s.points.at(-1)!.units).toBe(2);
    expect(s.points[0].startMs % HOUR).toBe(0);
  });

  it("chooses hourly buckets up to two days, daily beyond", () => {
    expect(granularityFor({ fromMs: 0, toMs: 2 * DAY })).toBe("hour");
    expect(granularityFor({ fromMs: 0, toMs: 2 * DAY + 1 })).toBe("day");
  });
});

describe("replay-time filtering and timeline", () => {
  it("never shows future orders or events and orders the timeline chronologically", () => {
    const mid = startMs() + 0.5 * (endMs() - startMs());
    const snap = snapshotAt(mid);
    const orderId = Object.values(snap.state.productionOrders).find((o) => o.status === "COMPLETED")!.id;
    const detail = workOrderDetail(snap, orderId)!;
    expect(detail.summary.id).toBe(orderId);
    const times = detail.timeline.map((e) => Date.parse(e.timestamp));
    expect(times.every((t) => t <= mid)).toBe(true);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    const seqs = detail.timeline.map((e) => e.sequence);
    expect(new Set(seqs).size).toBe(seqs.length);

    // A future order does not exist yet.
    const later = snapshotAt(endMs());
    const futureId = Object.values(later.state.productionOrders).find((o) => Date.parse(o.createdAt) > mid)!.id;
    expect(workOrderDetail(snap, futureId)).toBeNull();
    expect(workOrderSummaries(snap).some((s) => s.id === futureId)).toBe(false);
  });

  it("a snapshot at the creation time contains only the creation event", () => {
    const snapEnd = snapshotAt(endMs());
    const order = Object.values(snapEnd.state.productionOrders)[5];
    const t = Date.parse(order.createdAt);
    const early = snapshotAt(t);
    const tl = workOrderTimeline(early, order.id);
    expect(tl.every((e) => Date.parse(e.timestamp) <= t)).toBe(true);
    expect(tl[0].type).toBe("PRODUCTION_ORDER_CREATED");
    expect(workOrderTimeline(snapshotAt(t - 1), order.id)).toEqual([]);
  });

  it("detail derives routing and materials from master data without fabricating values", () => {
    const snap = snapshotAt(endMs());
    const o = Object.values(snap.state.productionOrders).find((x) => x.status === "COMPLETED")!;
    const d = workOrderDetail(snap, o.id)!;
    const routing = data.master.routings.find((r) => r.productId === o.productId)!;
    expect(d.routing.filter((r) => !r.isRework).map((r) => r.sequence)).toEqual(routing.steps.map((s) => s.sequence));
    expect(d.routing.every((r) => r.status === "COMPLETED")).toBe(true);
    const bom = data.master.billsOfMaterials.find((b) => b.productId === o.productId)!;
    expect(d.materials.map((m) => m.required)).toEqual(bom.lines.map((l) => l.quantityPer * o.quantity));
    expect(d.materials.every((m) => m.consumed === m.required && m.reserved === 0)).toBe(true);
    expect(d.inspections.length).toBe(o.inspectionIds.length);
  });
});

describe("reset / seek consistency", () => {
  it("seek, reset and seek back give the same reporting state as a fresh replay", () => {
    const sim = newSim();
    const t = startMs() + 0.4 * (endMs() - startMs());
    sim.seekTo(t);
    const a = reportingSnapshot(sim);
    const countsA = workOrderCounts(workOrderSummaries(a));
    const fresh = snapshotAt(t);
    expect(countsA).toEqual(workOrderCounts(workOrderSummaries(fresh)));
    expect(goodUnitsThroughput(a, "all").total).toBe(goodUnitsThroughput(fresh, "all").total);

    // Seek backward: orders created after the target disappear.
    const early = startMs() + 0.1 * (endMs() - startMs());
    sim.seekTo(early);
    const b = reportingSnapshot(sim);
    const ids = new Set(workOrderSummaries(b).map((s) => s.id));
    expect(workOrderSummaries(a).some((s) => !ids.has(s.id))).toBe(true);
    expect(b.events.every((e) => Date.parse(e.timestamp) <= early)).toBe(true);
    expect(goodUnitsThroughput(b, "all").total).toBeLessThanOrEqual(goodUnitsThroughput(a, "all").total);

    // End, then reset: back to the initial reporting state.
    sim.seekTo(endMs());
    const end = reportingSnapshot(sim);
    expect(workOrderCounts(workOrderSummaries(end)).completed).toBeGreaterThan(0);
    sim.reset();
    const r = reportingSnapshot(sim);
    expect(r.events.length).toBe(0);
    expect(workOrderCounts(workOrderSummaries(r)).total).toBe(Object.keys(data.initialState.productionOrders).length);
    expect(goodUnitsThroughput(r, "all").total).toBe(0);
  });
});
