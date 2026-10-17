import { describe, expect, it } from "vitest";
import { equipmentLoad, workCenterLoad, type ReportingSnapshot } from "../src/analytics/index.ts";
import { HOUR } from "../src/manufacturing/calendar.ts";
import { generateDataset } from "../src/manufacturing/generator.ts";
import { changeoverSetup, pickEquipment } from "../src/manufacturing/rules.ts";
import { replayWithGuard } from "../src/manufacturing/state.ts";
import { validateDataset } from "../src/manufacturing/validation.ts";
import { snapshotAt as sharedSnapshotAt } from "./helpers/snapshot.ts";
import type { FactoryEvent, InitialStateFile, ManufacturingDataset } from "../src/manufacturing/types.ts";

const d = generateDataset();
const initial: InitialStateFile = { schemaVersion: d.manifest.schemaVersion, master: d.master, state: d.initialState };

const snapshotAt = (data: ManufacturingDataset, ms: number): ReportingSnapshot => sharedSnapshotAt(initial, data.events, ms);

/** Events up to (excluding) the first OPERATION_STARTED matching `pick`, plus that event for mutation. */
function upToFirst(pick: (e: Extract<FactoryEvent, { type: "OPERATION_STARTED" }>) => boolean) {
  const idx = d.events.findIndex((e) => e.type === "OPERATION_STARTED" && pick(e));
  expect(idx).toBeGreaterThan(-1);
  return { before: d.events.slice(0, idx), event: structuredClone(d.events[idx]) as Extract<FactoryEvent, { type: "OPERATION_STARTED" }> };
}

describe("changeover table", () => {
  const rule = (wc: string, from: string, to: string) => changeoverSetup(d.master, wc, from, to)!;

  it("makes a repeat run cheaper than standard and a switch dearer, more so going up in complexity", () => {
    const std = d.master.routings.find((r) => r.productId === "NCP-300")!.steps.find((s) => s.workCenterId === "WC-WIRING")!.setupMinutes;
    expect(rule("WC-WIRING", "NCP-300", "NCP-300")).toBeLessThan(std);
    expect(rule("WC-WIRING", "NCP-100", "NCP-300")).toBe(std + 10);
    expect(rule("WC-WIRING", "NCP-200", "NCP-300")).toBe(std + 5);
    // Down two levels to NCP-100 (standard wiring setup 10): 10 + 2 x 2.
    expect(rule("WC-WIRING", "NCP-300", "NCP-100")).toBe(14);
  });

  it("is asymmetric: the pair's two directions differ", () => {
    expect(rule("WC-WIRING", "NCP-100", "NCP-300")).not.toBe(rule("WC-WIRING", "NCP-300", "NCP-100"));
  });

  it("applies the table in the generated run, and every switch is recorded on the operation", () => {
    const started = Object.values(d.finalState.productionOperations).filter((o) => o.startedAt && !o.isRework);
    const switched = started.filter((o) => o.changeoverFromProductId);
    expect(switched.length).toBeGreaterThan(0);
    for (const op of switched) {
      const product = d.finalState.productionOrders[op.productionOrderId].productId;
      expect(op.setupMinutes).toBe(changeoverSetup(d.master, op.workCenterId, op.changeoverFromProductId, product));
    }
    expect(started.some((o) => o.setupMinutes! < o.standardSetupMinutes!)).toBe(true);
  });

  it("is not applied to rework", () => {
    for (const op of Object.values(d.finalState.productionOperations).filter((o) => o.isRework && o.startedAt)) {
      expect(op.setupMinutes).toBe(op.standardSetupMinutes);
      expect(op.changeoverFromProductId).toBeUndefined();
    }
  });

  it("is enforced by the reducer", () => {
    const { before, event } = upToFirst((e) => e.payload.changeoverFromProductId !== undefined);
    event.payload.setupMinutes = event.payload.setupMinutes! + 1;
    const res = replayWithGuard(d.master, initial.state, [...before, event]);
    expect(res.error).toMatch(/setup/);
  });

  it("rejects a claimed changeover origin that does not match the station history", () => {
    const { before, event } = upToFirst((e) => e.payload.changeoverFromProductId !== undefined);
    delete event.payload.changeoverFromProductId;
    expect(replayWithGuard(d.master, initial.state, [...before, event]).error).toMatch(/changeover origin/);
  });
});

describe("equipment", () => {
  it("passes dataset validation, including exclusive use and routing requirements", () => {
    const report = validateDataset(d);
    expect(report.ok).toBe(true);
    const names = report.checks.map((c) => c.name);
    expect(names).toContain("equipment is exclusive and matches routing requirements");
    expect(names).toContain("setup minutes follow the changeover table");
  });

  it("is held by every started step that requires it, and never otherwise", () => {
    for (const op of Object.values(d.finalState.productionOperations).filter((o) => o.startedAt)) {
      expect(op.equipmentIds?.length ?? 0).toBe(op.requiredEquipment?.length ?? 0);
    }
    const wire = Object.values(d.finalState.productionOperations).find((o) => o.type === "WIRE" && o.startedAt)!;
    expect(wire.requiredEquipment).toEqual(["CRIMP_TOOL"]);
  });

  it("is a real limit: more wiring-capable stations than crimp tools", () => {
    const stations = d.master.workstations.filter((w) => w.workCenterIds?.includes("WC-WIRING")).length;
    const tools = d.master.equipment!.filter((e) => e.kind === "CRIMP_TOOL").length;
    expect(stations).toBeGreaterThan(tools);
  });

  it("is released when the operation completes", () => {
    for (const rt of Object.values(d.finalState.equipment!)) {
      const holder = rt.currentOperationId && d.finalState.productionOperations[rt.currentOperationId];
      if (holder) expect(holder.status === "RUNNING" || holder.status === "PAUSED").toBe(true);
    }
  });

  it("is enforced by the reducer: a start with no equipment is rejected", () => {
    const { before, event } = upToFirst((e) => (e.payload.equipmentIds?.length ?? 0) > 0);
    delete event.payload.equipmentIds;
    expect(replayWithGuard(d.master, initial.state, [...before, event]).error).toMatch(/needs 1 equipment/);
  });

  it("is enforced by the reducer: equipment of the wrong kind is rejected", () => {
    const { before, event } = upToFirst((e) => e.payload.equipmentIds?.[0]?.startsWith("EQ-CRIMP") === true);
    event.payload.equipmentIds = ["EQ-HIPOT-01"];
    expect(replayWithGuard(d.master, initial.state, [...before, event]).error).toMatch(/wrong kind/);
  });

  it("is enforced by the reducer: a unit already in use is rejected", () => {
    // Find a crimp step that starts while another crimp step still holds its tool, then point it at that tool.
    const running = new Map<string, string>(); // operation id -> held unit
    let held: string | undefined;
    let at = -1;
    for (let i = 0; i < d.events.length && at < 0; i++) {
      const e = d.events[i];
      if (e.type === "OPERATION_COMPLETED") running.delete(e.payload.productionOperationId);
      if (e.type === "OPERATION_STARTED" && e.payload.equipmentIds?.[0]?.startsWith("EQ-CRIMP")) {
        if (running.size > 0) {
          held = [...running.values()][0];
          at = i;
        }
        running.set(e.payload.productionOperationId, e.payload.equipmentIds[0]);
      }
    }
    expect(at, "no overlapping crimp steps in the dataset").toBeGreaterThan(-1);
    const dup = structuredClone(d.events[at]) as Extract<FactoryEvent, { type: "OPERATION_STARTED" }>;
    dup.payload.equipmentIds = [held!];
    expect(replayWithGuard(d.master, initial.state, [...d.events.slice(0, at), dup]).error).toMatch(/not free/);
  });

  it("pickEquipment is deterministic and reports exhaustion", () => {
    const state = structuredClone(d.initialState);
    expect(pickEquipment(d.master, state, ["CRIMP_TOOL"])).toEqual(["EQ-CRIMP-01"]);
    expect(pickEquipment(d.master, state, ["CRIMP_TOOL", "CRIMP_TOOL"])).toEqual(["EQ-CRIMP-01", "EQ-CRIMP-02"]);
    expect(pickEquipment(d.master, state, ["CRIMP_TOOL", "CRIMP_TOOL", "CRIMP_TOOL"])).toBeUndefined();
    state.equipment!["EQ-CRIMP-01"].currentOperationId = "OP-X";
    expect(pickEquipment(d.master, state, ["CRIMP_TOOL"])).toEqual(["EQ-CRIMP-02"]);
    expect(pickEquipment(d.master, state, undefined)).toEqual([]);
  });
});

describe("equipment and changeover analytics", () => {
  const start = Date.parse(d.initialState.asOf);
  const end = Date.parse(d.finalState.asOf);

  it("reports each pooled unit with a utilization between 0 and 1", () => {
    const rows = equipmentLoad(snapshotAt(d, end), "all");
    expect(rows.map((r) => r.equipmentId)).toEqual(d.master.equipment!.map((e) => e.id));
    for (const r of rows) {
      expect(r.utilization!).toBeGreaterThan(0);
      expect(r.utilization!).toBeLessThanOrEqual(1);
    }
  });

  it("shows steps waiting on equipment at some point, and never more than are queued", () => {
    let sawWaiting = false;
    for (let t = start + 24 * HOUR; t < end; t += 6 * HOUR) {
      const snap = snapshotAt(d, t);
      for (const r of workCenterLoad(snap, "all")) {
        expect(r.waitingOnEquipment).toBeLessThanOrEqual(r.queuedOrders);
        if (r.waitingOnEquipment > 0) sawWaiting = true;
      }
    }
    expect(sawWaiting).toBe(true);
  });

  it("totals applied setup and changeovers per work center", () => {
    const rows = workCenterLoad(snapshotAt(d, end), "all");
    const ops = Object.values(d.finalState.productionOperations).filter((o) => o.startedAt);
    for (const r of rows) {
      const mine = ops.filter((o) => o.workCenterId === r.workCenterId);
      expect(r.changeovers).toBe(mine.filter((o) => o.changeoverFromProductId).length);
      expect(r.setupMinutes).toBe(mine.reduce((s, o) => s + (o.setupMinutes ?? o.standardSetupMinutes ?? 0), 0));
    }
  });

  it("is empty for pre-1.3.0 master data", () => {
    const old = structuredClone(snapshotAt(d, end));
    delete old.master.equipment;
    expect(equipmentLoad(old, "all")).toEqual([]);
  });
});
