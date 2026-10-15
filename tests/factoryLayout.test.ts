import { describe, expect, it } from "vitest";
import {
  building,
  departments,
  dockDoors,
  factoryLayout,
  floorMarkings,
} from "../src/data/factoryLayout.ts";
import type { FloorRect } from "../src/data/layoutTypes.ts";
import { buildStationParts } from "../src/graphics/stationModels.ts";

const ids = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${prefix}-${String(i + 1).padStart(3, "0")}`);

const EXPECTED_IDS = [
  ...ids("REC", 3), ...ids("INV", 4), ...ids("ASM", 6), ...ids("QC", 3), ...ids("SHP", 3),
];

const footprint = (o: (typeof factoryLayout)[number]): FloorRect => ({
  minX: o.position[0] - o.size[0] / 2,
  maxX: o.position[0] + o.size[0] / 2,
  minZ: o.position[2] - o.size[2] / 2,
  maxZ: o.position[2] + o.size[2] / 2,
});

const overlaps = (a: FloorRect, b: FloorRect, gap = 0) =>
  a.minX < b.maxX + gap && a.maxX > b.minX - gap &&
  a.minZ < b.maxZ + gap && a.maxZ > b.minZ - gap;

const contains = (outer: FloorRect, inner: FloorRect, margin = 0) =>
  inner.minX >= outer.minX + margin && inner.maxX <= outer.maxX - margin &&
  inner.minZ >= outer.minZ + margin && inner.maxZ <= outer.maxZ - margin;

describe("factory layout", () => {
  it("keeps every station ID the simulation maps", () => {
    expect(factoryLayout.map((o) => o.id).sort()).toEqual([...EXPECTED_IDS].sort());
  });

  it("assigns each station to the department matching its ID prefix", () => {
    const byPrefix: Record<string, string> = {
      REC: "receiving", INV: "inventory", ASM: "assembly", QC: "quality", SHP: "shipping",
    };
    for (const o of factoryLayout) {
      expect(o.department, o.id).toBe(byPrefix[o.id.split("-")[0]!]);
    }
  });

  it("keeps stations inside their department zone with edge margin", () => {
    for (const o of factoryLayout) {
      const zone = departments.find((d) => d.id === o.department)!;
      expect(contains(zone.bounds, footprint(o), 0.5), o.id).toBe(true);
    }
  });

  it("keeps stations from overlapping and leaves >= 1.2 m between them", () => {
    for (let i = 0; i < factoryLayout.length; i++) {
      for (let j = i + 1; j < factoryLayout.length; j++) {
        const a = factoryLayout[i]!;
        const b = factoryLayout[j]!;
        expect(overlaps(footprint(a), footprint(b), 1.2), `${a.id}/${b.id}`).toBe(false);
      }
    }
  });

  it("keeps department zones disjoint and inside the building", () => {
    for (const d of departments) {
      expect(contains(building.bounds, d.bounds, 1.5), d.id).toBe(true);
    }
    for (let i = 0; i < departments.length; i++) {
      for (let j = i + 1; j < departments.length; j++) {
        expect(overlaps(departments[i]!.bounds, departments[j]!.bounds)).toBe(false);
      }
    }
  });

  it("keeps stations out of aisles and walkways", () => {
    const clear = [...floorMarkings.aisles, ...floorMarkings.walkways];
    for (const o of factoryLayout) {
      for (const lane of clear) {
        expect(overlaps(footprint(o), lane), o.id).toBe(false);
      }
    }
  });

  it("keeps the main material-handling aisle 3.5-4 m wide", () => {
    const main = floorMarkings.aisles[0]!;
    expect(main.maxZ - main.minZ).toBeGreaterThanOrEqual(3.5);
    expect(main.maxZ - main.minZ).toBeLessThanOrEqual(4);
  });

  it("puts dock doors on exterior walls beside receiving / shipping", () => {
    for (const door of dockDoors) {
      const zone = departments.find((d) => d.id === door.department)!;
      expect(door.z).toBeGreaterThan(zone.bounds.minZ);
      expect(door.z).toBeLessThan(zone.bounds.maxZ);
    }
  });

  it("has station parts that stay inside the declared envelope", () => {
    for (const o of factoryLayout) {
      const [w, h, d] = o.size;
      expect(buildStationParts(o).some((p) => p.material === "status"), o.id).toBe(true);
      for (const p of buildStationParts(o)) {
        const eps = 1e-6;
        expect(Math.abs(p.pos[0]) + p.size[0] / 2, `${o.id} x`).toBeLessThanOrEqual(w / 2 + eps);
        expect(Math.abs(p.pos[2]) + p.size[2] / 2, `${o.id} z`).toBeLessThanOrEqual(d / 2 + eps);
        expect(p.pos[1] - p.size[1] / 2, `${o.id} floor`).toBeGreaterThanOrEqual(-eps);
        expect(p.pos[1] + p.size[1] / 2, `${o.id} top`).toBeLessThanOrEqual(h + eps);
      }
    }
  });
});
