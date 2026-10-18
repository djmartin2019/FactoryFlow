import { describe, expect, it } from "vitest";
import { inventoryReport, materialShortages, type ReportingSnapshot } from "../src/analytics/index.ts";
import { HOUR } from "../src/manufacturing/calendar.ts";
import { generateDataset } from "../src/manufacturing/generator.ts";
import { FactoryReplay } from "../src/manufacturing/replay.ts";
import { inventoryByLocation } from "../src/manufacturing/selectors.ts";
import type { FactoryState } from "../src/manufacturing/types.ts";
import { endSnapshot, initialFileOf } from "./helpers/snapshot.ts";

const data = generateDataset();
const initial = initialFileOf(data);
const START = Date.parse(initial.state.asOf);

function* samples(stepHours = 12): Generator<ReportingSnapshot> {
  const r = new FactoryReplay(structuredClone(initial), data.events);
  for (let h = stepHours; h < 30 * 24; h += stepHours) {
    const ms = START + h * HOUR;
    r.advanceToMs(ms);
    yield { asOfMs: ms, startMs: START, master: initial.master, state: r.state, events: r.appliedEvents() };
  }
  yield endSnapshot(initial, data.events);
}

describe("inventory report", () => {
  it("lists every location and every master item exactly once", () => {
    const s = endSnapshot(initial, data.events);
    const rep = inventoryReport(s);
    expect(rep.locations.map((l) => l.locationId)).toEqual(s.master.locations.map((l) => l.id));
    expect(rep.items.filter((i) => i.kind === "RAW_MATERIAL").map((i) => i.itemId)).toEqual(s.master.materials.map((m) => m.id));
    expect(rep.items.filter((i) => i.kind === "FINISHED_GOOD").map((i) => i.itemId)).toEqual(s.master.products.map((p) => p.id));
    expect(new Set(rep.items.map((i) => i.itemId)).size).toBe(rep.items.length);
  });

  it("reproduces the pallet fill of the existing location selector, and the stock totals of the inventory balances", () => {
    for (const s of samples()) {
      const rep = inventoryReport(s);
      const sel = inventoryByLocation(s.state as FactoryState, s.master);
      for (const l of rep.locations) {
        expect(l.palletsUsed).toBe(sel[l.locationId].palletsUsed);
        expect(l.palletCapacity).toBe(sel[l.locationId].palletCapacity);
        expect(l.fill).toBe(sel[l.locationId].utilization);
        expect(l.itemsStocked).toBe(sel[l.locationId].items.length);
      }
      for (const i of rep.items) {
        const balances = Object.values(s.state.inventory).filter((b) => b.itemId === i.itemId);
        expect(i.onHand, i.itemId).toBe(balances.reduce((n, b) => n + b.onHand, 0));
        expect(i.reserved, i.itemId).toBe(balances.reduce((n, b) => n + b.reserved, 0));
        expect(i.locations.reduce((n, l) => n + l.onHand, 0), i.itemId).toBe(i.onHand);
        expect(i.available, i.itemId).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("uses the release rule for raw-material availability, equal to the Material Shortages tab", () => {
    let checked = 0;
    for (const s of samples()) {
      const rep = inventoryReport(s);
      const shortage = materialShortages(s);
      for (const o of shortage.blockedOrders)
        for (const l of o.lines) {
          const item = rep.items.find((i) => i.itemId === l.materialId)!;
          expect(item.available, `${l.materialId} at ${new Date(s.asOfMs).toISOString()}`).toBe(l.availableNow);
          checked++;
        }
      // finished goods: on hand minus reserved
      for (const i of rep.items.filter((x) => x.kind === "FINISHED_GOOD")) expect(i.available).toBe(i.onHand - i.reserved);
    }
    expect(checked).toBeGreaterThan(20);
  });

  it("flags exactly the materials that blocked work orders are short of, with the same order counts", () => {
    let shortSeen = 0;
    for (const s of samples()) {
      const rep = inventoryReport(s);
      const shortage = materialShortages(s);
      const expected = new Map(shortage.byMaterial.map((m) => [m.materialId, m.blockedOrders]));
      for (const i of rep.items) {
        expect(i.short, i.itemId).toBe(expected.has(i.itemId));
        expect(i.blockedOrders, i.itemId).toBe(expected.get(i.itemId) ?? 0);
      }
      shortSeen += expected.size;
    }
    expect(shortSeen).toBeGreaterThan(0);
  });

  it("sums outstanding purchase-order quantity and the earliest promised date from the open orders", () => {
    for (const s of samples(48)) {
      const rep = inventoryReport(s);
      for (const m of s.master.materials) {
        const lines = Object.values(s.state.purchaseOrders)
          .filter((po) => po.status !== "RECEIVED")
          .flatMap((po) => po.lines.filter((l) => l.materialId === m.id && l.orderedQuantity > l.receivedQuantity).map((l) => ({ open: l.orderedQuantity - l.receivedQuantity, at: Date.parse(po.promisedDeliveryAt) })));
        const item = rep.items.find((i) => i.itemId === m.id)!;
        expect(item.openPurchaseOrderQuantity, m.id).toBe(lines.reduce((n, l) => n + l.open, 0));
        expect(item.earliestPromisedMs, m.id).toBe(lines.length ? Math.min(...lines.map((l) => l.at)) : null);
      }
      for (const i of rep.items.filter((x) => x.kind === "FINISHED_GOOD")) {
        expect(i.openPurchaseOrderQuantity).toBeNull();
        expect(i.earliestPromisedMs).toBeNull();
      }
    }
  });

  it("is deterministic and does not mutate the snapshot", () => {
    const s = endSnapshot(initial, data.events);
    const before = JSON.stringify(s.state.inventory);
    expect(inventoryReport(s)).toEqual(inventoryReport(s));
    expect(JSON.stringify(s.state.inventory)).toBe(before);
  });
});
