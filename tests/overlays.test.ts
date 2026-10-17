import { describe, expect, it } from "vitest";
import { OVERLAY_MODES, highlightedIds, materialShortages, overlayFor, periodWindow, type ReportingSnapshot } from "../src/analytics/index.ts";
import { HOUR } from "../src/manufacturing/calendar.ts";
import { stationMetrics } from "../src/manufacturing/dashboardMetrics.ts";
import { generateDataset } from "../src/manufacturing/generator.ts";
import { factoryObjectsForEntity } from "../src/manufacturing/mapping.ts";
import { FactoryReplay } from "../src/manufacturing/replay.ts";
import { readyOperations } from "../src/manufacturing/selectors.ts";
import type { FactoryState, Id } from "../src/manufacturing/types.ts";
import { factoryLayout } from "../src/data/factoryLayout.ts";
import { endSnapshot, initialFileOf } from "./helpers/snapshot.ts";

const data = generateDataset();
const initial = initialFileOf(data);
const START = Date.parse(initial.state.asOf);
const layoutIds = new Set(factoryLayout.map((o) => o.id));

/** Snapshots across the run, including off-shift hours, weekends and times with queues, outages and shortages. */
function* samples(stepHours = 6): Generator<ReportingSnapshot> {
  const r = new FactoryReplay(structuredClone(initial), data.events);
  for (let h = stepHours; h < 30 * 24; h += stepHours) {
    const ms = START + h * HOUR;
    r.advanceToMs(ms);
    yield { asOfMs: ms, startMs: START, master: initial.master, state: r.state, events: r.appliedEvents() };
  }
}

describe("overlays highlight exactly what the matching analytics say", () => {
  it("status is the default view and has no overlay", () => {
    const s = endSnapshot(initial, data.events);
    expect(overlayFor(s, "status", "24h")).toBeNull();
    expect(highlightedIds(null).size).toBe(0);
    expect(OVERLAY_MODES[0]).toBe("status");
  });

  it("queue: highlights the stations with orders waiting, derived independently from the ready operations", () => {
    let nonEmpty = 0;
    for (const s of samples()) {
      const overlay = overlayFor(s, "queue", "24h")!;
      const ready = readyOperations(s.state as FactoryState);
      const awaitingQc = Object.values(s.state.productionOrders).some((o) => o.stage === "AWAITING_QC");
      const expected = new Set<Id>();
      for (const ws of s.master.workstations) {
        if (ws.kind === "ASSEMBLY") {
          const served = new Set(ws.workCenterIds ?? []);
          if (ready.some((r) => r.operation.workstationKind === "ASSEMBLY" && (served.size === 0 || !r.workCenterId || served.has(r.workCenterId)))) expected.add(ws.id);
        } else if (ws.kind === "INSPECTION" && awaitingQc) expected.add(ws.id);
      }
      expect(highlightedIds(overlay), new Date(s.asOfMs).toISOString()).toEqual(expected);
      if (expected.size) {
        nonEmpty++;
        expect(Math.max(...overlay.cells.map((c) => c.intensity))).toBe(1);
      }
      for (const c of overlay.cells) {
        expect(c.value).toBeGreaterThan(0);
        expect(c.intensity).toBeGreaterThan(0);
        expect(c.intensity).toBeLessThanOrEqual(1);
      }
    }
    expect(nonEmpty).toBeGreaterThan(10);
  });

  it("utilization: highlights the stations that have a utilization figure, with the station table's value for the chosen period", () => {
    for (const period of ["24h", "7d", "all"] as const) {
      for (const s of samples(48)) {
        const overlay = overlayFor(s, "utilization", period)!;
        const metrics = stationMetrics(s.state, s.master, periodWindow(period, s.asOfMs, s.startMs));
        const withFigure = metrics.filter((m) => m.utilization !== null);
        expect(highlightedIds(overlay), `${period} ${new Date(s.asOfMs).toISOString()}`).toEqual(new Set(withFigure.map((m) => m.workstationId)));
        for (const c of overlay.cells) {
          expect(c.value).toBe(metrics.find((m) => m.workstationId === c.objectId)!.utilization);
          expect(c.intensity).toBe(Math.min(1, c.value));
        }
      }
    }
  });

  it("shortage: highlights the racks holding materials that blocked work orders are short of, weighted by the orders affected", () => {
    let nonEmpty = 0;
    for (const s of samples()) {
      const overlay = overlayFor(s, "shortage", "24h")!;
      const report = materialShortages(s);
      const expected = new Map<Id, Set<Id>>();
      for (const o of report.blockedOrders)
        for (const l of o.lines) {
          const loc = s.master.materials.find((m) => m.id === l.materialId)!.storageLocationId;
          expected.set(loc, (expected.get(loc) ?? new Set()).add(o.orderId));
        }
      expect(highlightedIds(overlay), new Date(s.asOfMs).toISOString()).toEqual(new Set(expected.keys()));
      for (const c of overlay.cells) expect(c.value).toBe(expected.get(c.objectId)!.size);
      if (expected.size) {
        nonEmpty++;
        expect(Math.max(...overlay.cells.map((c) => c.intensity))).toBe(1);
      }
    }
    expect(nonEmpty).toBeGreaterThan(10);
  });

  it("only ever highlights objects that exist in the 3D layout, and describes itself", () => {
    for (const mode of OVERLAY_MODES) {
      if (mode === "status") continue;
      for (const s of samples(24)) {
        const overlay = overlayFor(s, mode, "7d")!;
        expect(overlay.title.length).toBeGreaterThan(0);
        expect(overlay.legend.muted.length).toBeGreaterThan(0);
        for (const c of overlay.cells) {
          expect(layoutIds.has(c.objectId), `${mode} ${c.objectId}`).toBe(true);
          expect(c.caption.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("is deterministic and does not mutate the snapshot", () => {
    const s = endSnapshot(initial, data.events);
    const before = JSON.stringify(s.state.workstations) + JSON.stringify(s.state.inventory);
    for (const mode of OVERLAY_MODES) expect(overlayFor(s, mode, "7d")).toEqual(overlayFor(s, mode, "7d"));
    expect(JSON.stringify(s.state.workstations) + JSON.stringify(s.state.inventory)).toBe(before);
  });
});

describe("Explorer to 3D cross-highlight (mapping)", () => {
  const end = endSnapshot(initial, data.events);
  const state = end.state as FactoryState;

  it("maps every work order, customer order, shipment, material, product and purchase order to objects that exist in the layout", () => {
    const check = (kind: Parameters<typeof factoryObjectsForEntity>[0]["kind"], id: Id) => {
      for (const objectId of factoryObjectsForEntity({ kind, id } as never, state, end.master)) expect(layoutIds.has(objectId), `${kind} ${id} -> ${objectId}`).toBe(true);
    };
    for (const id of Object.keys(state.productionOrders)) check("productionOrder", id);
    for (const id of Object.keys(state.customerOrders)) check("customerOrder", id);
    for (const id of Object.keys(state.shipments)) check("shipment", id);
    for (const id of Object.keys(state.purchaseOrders)) check("purchaseOrder", id);
    for (const m of end.master.materials) check("material", m.id);
    for (const p of end.master.products) check("product", p.id);
  });

  it("puts a work order where it is, and a short material on its storage rack", () => {
    const running = Object.values(state.productionOrders).find((o) => o.currentLocationId);
    expect(running).toBeDefined();
    expect(factoryObjectsForEntity({ kind: "productionOrder", id: running!.id }, state, end.master)).toEqual([running!.currentLocationId]);
    const m = end.master.materials[0];
    expect(factoryObjectsForEntity({ kind: "material", id: m.id }, state, end.master)).toEqual([m.storageLocationId]);
  });

  it("returns nothing for an unknown entity, so the Explorer shows no button rather than a wrong object", () => {
    expect(factoryObjectsForEntity({ kind: "productionOrder", id: "WO-NOPE" }, state, end.master)).toEqual([]);
    expect(factoryObjectsForEntity({ kind: "customerOrder", id: "CO-NOPE" }, state, end.master)).toEqual([]);
    expect(factoryObjectsForEntity({ kind: "material", id: "MAT-NOPE" }, state, end.master)).toEqual([]);
  });
});
