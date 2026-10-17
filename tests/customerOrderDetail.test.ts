import { describe, expect, it } from "vitest";
import { customerOrderDetail, dispatchReport, workOrderDetail } from "../src/analytics/index.ts";
import { HOUR } from "../src/manufacturing/calendar.ts";
import { generateDataset } from "../src/manufacturing/generator.ts";
import { endSnapshot, initialFileOf, snapshotAt } from "./helpers/snapshot.ts";

const data = generateDataset();
const initial = initialFileOf(data);
const end = endSnapshot(initial, data.events);

describe("customer order detail (S5)", () => {
  const shipped = Object.values(end.state.customerOrders).find((o) => o.status === "SHIPPED" && Object.values(end.state.shipments).filter((s) => s.customerOrderId === o.id).length > 1)
    ?? Object.values(end.state.customerOrders).find((o) => o.status === "SHIPPED")!;
  const d = customerOrderDetail(end, shipped.id)!;

  it("returns null for an unknown order and for one that does not exist yet", () => {
    expect(customerOrderDetail(end, "CO-NOPE")).toBeNull();
    const start = snapshotAt(initial, data.events, Date.parse(initial.state.asOf));
    const later = Object.values(end.state.customerOrders).find((o) => Date.parse(o.createdAt) > start.asOfMs)!;
    expect(customerOrderDetail(start, later.id)).toBeNull();
  });

  it("uses the Dispatch tab's figures for the order", () => {
    const fromReport = dispatchReport(end, "all").orders.find((o) => o.orderId === shipped.id)!;
    expect(d.dispatch).toEqual(fromReport);
  });

  it("lists lines whose quantities reconcile with the order and its shipments", () => {
    expect(d.lines.length).toBe(shipped.lines.length);
    for (const l of d.lines) {
      expect(l.unshippedQuantity).toBe(l.quantity - l.shippedQuantity);
      const dispatched = d.shipments.flatMap((s) => s.lines).filter((x) => x.lineId === l.lineId).reduce((n, x) => n + x.quantity, 0);
      expect(dispatched, l.lineId).toBe(l.shippedQuantity);
    }
  });

  it("lists shipments in dispatch order, each marked against the due date, and allocations that cover what shipped", () => {
    const times = d.shipments.map((s) => s.dispatchedAtMs);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    for (const s of d.shipments) expect(s.onTime).toBe(s.dispatchedAtMs <= d.dispatch.dueMs);
    const allocated = d.allocations.reduce((n, a) => n + a.quantity, 0);
    expect(allocated).toBeGreaterThanOrEqual(d.dispatch.shippedQuantity);
    expect(d.allocations.every((a) => a.timestampMs <= d.dispatch.finalDispatchMs!)).toBe(true);
  });

  it("links to the work orders planned for the order, and the work order links back", () => {
    for (const o of Object.values(end.state.customerOrders)) {
      const detail = customerOrderDetail(end, o.id)!;
      expect(detail.plannedWorkOrders.map((w) => w.id), o.id).toEqual(detail.dispatch.plannedWorkOrderIds);
      for (const w of detail.plannedWorkOrders) {
        const wo = workOrderDetail(end, w.id)!;
        expect(wo.customerOrders.map((c) => c.id), `${w.id} -> ${o.id}`).toContain(o.id);
        expect(w.lineIds.length).toBeGreaterThan(0);
        for (const lineId of w.lineIds) expect(o.lines.some((l) => l.id === lineId)).toBe(true);
      }
    }
  });

  it("shows only what has happened by the snapshot time", () => {
    const mid = snapshotAt(initial, data.events, Date.parse(d.dispatch.finalDispatchMs !== null ? new Date(d.dispatch.finalDispatchMs - HOUR).toISOString() : initial.state.asOf));
    const early = customerOrderDetail(mid, shipped.id);
    if (early) {
      expect(early.shipments.every((s) => s.dispatchedAtMs <= mid.asOfMs)).toBe(true);
      expect(early.allocations.every((a) => a.timestampMs <= mid.asOfMs)).toBe(true);
    }
  });

  it("is deterministic and does not mutate the snapshot", () => {
    const before = JSON.stringify(end.state.customerOrders[shipped.id]);
    expect(customerOrderDetail(end, shipped.id)).toEqual(customerOrderDetail(end, shipped.id));
    expect(JSON.stringify(end.state.customerOrders[shipped.id])).toBe(before);
  });
});
