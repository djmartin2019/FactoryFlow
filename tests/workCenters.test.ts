import { describe, expect, it } from "vitest";
import { workCenterLoad, type ReportingSnapshot } from "../src/analytics/index.ts";
import { factoryLayout } from "../src/data/factoryLayout.ts";
import { assemblyLanes } from "../src/manufacturing/masterData.ts";
import { generateDataset } from "../src/manufacturing/generator.ts";
import { FactoryReplay } from "../src/manufacturing/replay.ts";
import { validateDataset } from "../src/manufacturing/validation.ts";
import { initialFileOf, snapshotAt as sharedSnapshotAt } from "./helpers/snapshot.ts";
import type { FactoryEvent, ManufacturingDataset } from "../src/manufacturing/types.ts";

const ASSEMBLY_WCS = ["WC-KITTING", "WC-ASSEMBLY", "WC-WIRING", "WC-MOTOR", "WC-CONTROLS"];

const snapshotAt = (d: ManufacturingDataset, ms: number): ReportingSnapshot => sharedSnapshotAt(initialFileOf(d), d.events, ms);

describe("assembly lanes", () => {
  it("cover every assembly work center for any station count", () => {
    for (let n = 1; n <= 6; n++) {
      const covered = new Set(assemblyLanes(n).flat());
      for (const wc of ASSEMBLY_WCS) expect(covered.has(wc), `${wc} with ${n} stations`).toBe(true);
    }
  });
});

describe("station names", () => {
  it("describe the lane, and match the 3D layout for the default 6-station factory", () => {
    const d = generateDataset();
    const byId = new Map(d.master.workstations.map((w) => [w.id, w.name]));
    expect(byId.get("ASM-003")).toBe("Wiring & Termination A");
    expect(byId.get("ASM-005")).toBe("Wiring & Termination B");
    expect(byId.get("ASM-006")).toBe("Flex Assembly");
    for (const w of d.master.workstations) {
      expect(factoryLayout.find((o) => o.id === w.id)?.name, w.id).toBe(w.name);
    }
  });

  it("stay accurate when fewer stations share the lanes", () => {
    const d = generateDataset({ assemblyWorkstations: 1 });
    expect(d.master.workstations.find((w) => w.id === "ASM-001")!.name).toBe("Flex Assembly");
  });
});

describe("hopping between stations", () => {
  const d = generateDataset();

  it("runs every operation on a station that serves its work center", () => {
    const serves = new Map(d.master.workstations.map((w) => [w.id, w.workCenterIds ?? []]));
    for (const op of Object.values(d.finalState.productionOperations)) {
      if (!op.workstationId || !op.workCenterId) continue;
      expect(serves.get(op.workstationId), `${op.id} on ${op.workstationId}`).toContain(op.workCenterId);
    }
  });

  it("moves orders across more than one assembly station", () => {
    const hopped = Object.values(d.finalState.productionOrders).filter((o) => {
      const stations = new Set(
        o.operationIds.map((id) => d.finalState.productionOperations[id]).filter((op) => op.workstationKind === "ASSEMBLY" && op.workstationId).map((op) => op.workstationId),
      );
      return stations.size > 1;
    });
    expect(hopped.length).toBeGreaterThan(0);
  });

  it("passes dataset validation including work-center coverage", () => {
    expect(validateDataset(d).ok).toBe(true);
  });
});

describe("bottleneck identification", () => {
  // One station per lane, no flexible station, and a controls-heavy demand: controls must back up.
  const cfg = { seed: "bottleneck-1", days: 14, assemblyWorkstations: 5, machineFailuresPerWorkstation: 0, demandSurge: { startDay: 1, endDay: 14, multiplier: 2.5 } } as const;

  const peakQueue = (d: ManufacturingDataset) => {
    const end = Date.parse(d.finalState.asOf);
    let peak = 0;
    const flagged = new Set<string>();
    for (let t = Date.parse(d.initialState.asOf); t <= end; t += 12 * 3600_000) {
      const rows = workCenterLoad(snapshotAt(d, t), "7d");
      expect(rows.filter((r) => r.isBottleneck).length).toBeLessThanOrEqual(1);
      for (const r of rows) {
        peak = Math.max(peak, r.queuedMinutesPerStation ?? 0);
        if (r.isBottleneck) flagged.add(r.workCenterId);
      }
    }
    return { peak, flagged };
  };

  it("flags a work center where WIP waits, and a flexible station relieves it", () => {
    const tight = peakQueue(generateDataset(cfg));
    expect(tight.flagged.size).toBeGreaterThan(0);
    expect(tight.peak).toBeGreaterThan(0);
    const flex = peakQueue(generateDataset({ ...cfg, assemblyWorkstations: 6 }));
    expect(flex.peak).toBeLessThanOrEqual(tight.peak);
  });
});

describe("legacy logs", () => {
  it("replays a log whose master data predates work centers", () => {
    const d = generateDataset({ seed: "legacy-1", days: 7, assemblyWorkstations: 1, inspectionWorkstations: 1 });
    const master = structuredClone(d.master);
    delete master.workCenters;
    for (const w of master.workstations) delete w.workCenterIds;
    const r = new FactoryReplay({ schemaVersion: "1.1.0", master, state: structuredClone(d.initialState) }, d.events as FactoryEvent[]);
    expect(() => r.advanceToMs(Date.parse(d.finalState.asOf))).not.toThrow();
  });
});
