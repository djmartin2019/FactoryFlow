import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { workOrderDetail, type ReportingSnapshot } from "../src/analytics/index.ts";
import { generateDataset } from "../src/manufacturing/generator.ts";
import { FactoryReplay } from "../src/manufacturing/replay.ts";
import type { FactoryEvent, InitialStateFile, ManufacturingDataset } from "../src/manufacturing/types.ts";

const NCP300_TYPES = ["KIT", "MOUNT", "WIRE", "CONFIGURE", "FINAL_TEST"];

function endSnapshot(initial: InitialStateFile, events: FactoryEvent[]): ReportingSnapshot {
  const r = new FactoryReplay(structuredClone(initial), events);
  const last = Date.parse(events[events.length - 1].timestamp);
  r.advanceToMs(last);
  return { asOfMs: last, startMs: Date.parse(initial.state.asOf), master: initial.master, state: r.state, events: r.appliedEvents() };
}

describe("NCP-300 routing", () => {
  let data: ManufacturingDataset;
  let initial: InitialStateFile;
  beforeAll(() => {
    data = generateDataset();
    initial = { schemaVersion: data.manifest.schemaVersion, master: data.master, state: data.initialState };
  });

  it("defines kit -> mount -> wire -> configure -> test with work centers", () => {
    const routing = data.master.routings.find((r) => r.productId === "NCP-300")!;
    expect(routing.steps.map((s) => s.operationType)).toEqual(NCP300_TYPES);
    expect(routing.steps.every((s) => s.workCenterId)).toBe(true);
    const seqs = routing.steps.map((s) => s.sequence);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it("gives NCP-100 and NCP-200 their own work-center routings", () => {
    const types = (id: string) => data.master.routings.find((r) => r.productId === id)!.steps.map((s) => s.operationType);
    expect(types("NCP-100")).toEqual(["KIT", "MOUNT", "WIRE", "FINAL_TEST"]);
    expect(types("NCP-200")).toEqual(["KIT", "MOUNT", "WIRE", "MOTOR_CIRCUIT_ASSEMBLY", "FINAL_TEST"]);
    for (const r of data.master.routings) expect(r.steps.every((s) => s.workCenterId)).toBe(true);
  });

  it("traces an NCP-300 order that fails test, is reworked and passes retest", () => {
    const state = data.finalState;
    const order = Object.values(state.productionOrders).find(
      (o) =>
        o.productId === "NCP-300" &&
        o.status === "COMPLETED" &&
        o.inspectionIds.length >= 2 &&
        state.qualityInspections[o.inspectionIds[0]].reworkQuantity > 0 &&
        state.qualityInspections[o.inspectionIds[1]].failedQuantity === 0,
    );
    expect(order, "dataset contains a fail-once-then-pass NCP-300 order").toBeDefined();

    const detail = workOrderDetail(endSnapshot(initial, data.events), order!.id)!;
    expect(detail.inspections.map((i) => i.outcome).slice(0, 2)).toEqual(["REWORK", "PASSED"]);
    expect(detail.routing.filter((r) => !r.isRework).map((r) => r.operationType)).toEqual(NCP300_TYPES);
    const rework = detail.routing.filter((r) => r.isRework).map((r) => r.operationType);
    expect(rework).toEqual(["REWORK", "FINAL_TEST"]);
    expect(detail.routing.every((r) => r.status === "COMPLETED")).toBe(true);
    for (const r of detail.routing.filter((x) => !x.isRework)) expect(r.workCenter).toBeTruthy();
    for (const r of detail.routing) {
      expect(r.processingMinutes).toBeGreaterThan(0);
      expect(r.waitMinutes).toBeGreaterThanOrEqual(0);
    }
    expect(detail.reworkRequests).toHaveLength(1);
  });

  it("renders the same detail from the committed fixture with the engine off", () => {
    const dir = new URL("./fixtures/canonical/", import.meta.url);
    const fx: InitialStateFile = JSON.parse(readFileSync(new URL("initial_state.json", dir), "utf8"));
    const events: FactoryEvent[] = JSON.parse(readFileSync(new URL("events.json", dir), "utf8"));
    const snap = endSnapshot(fx, events);
    const first = Object.values(snap.state.productionOrders)[0];
    const detail = workOrderDetail(snap, first.id)!;
    expect(detail.routing.length).toBeGreaterThan(0);
    expect(detail.timeline.length).toBeGreaterThan(0);
    expect(detail.routing.every((r) => r.status === "COMPLETED")).toBe(true);
  });

  it("is deterministic for a given seed", () => {
    expect(generateDataset({ seed: "ncp300-a" }).manifest.eventLogHash).toBe(generateDataset({ seed: "ncp300-a" }).manifest.eventLogHash);
  });
});
