import { describe, expect, it } from "vitest";
import { workCenterLoad, workCenterQueues } from "../src/analytics/index.ts";
import { departments, factoryLayout, floorMarkings } from "../src/data/factoryLayout.ts";
import { BUFFER_SLOTS, bufferPad, bufferSlots, leadStations } from "../src/data/queueBuffers.ts";
import type { FloorRect } from "../src/data/layoutTypes.ts";
import { inShift, nextShiftStart, shiftMinutesBetween, weekdayShort } from "../src/manufacturing/calendar.ts";
import { generateDataset } from "../src/manufacturing/generator.ts";
import { FactoryReplay } from "../src/manufacturing/replay.ts";

const footprint = (o: (typeof factoryLayout)[number]): FloorRect => ({
  minX: o.position[0] - o.size[0] / 2,
  maxX: o.position[0] + o.size[0] / 2,
  minZ: o.position[2] - o.size[2] / 2,
  maxZ: o.position[2] + o.size[2] / 2,
});
const overlaps = (a: FloorRect, b: FloorRect) => a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;

const d = generateDataset();
const leads = leadStations(d.master.workstations);

describe("queue buffer placement", () => {
  it("leads every work center from a dedicated lane, never the flex station", () => {
    for (const wc of d.master.workCenters!) expect(leads.has(wc.id), wc.id).toBe(true);
    expect([...leads.values()]).not.toContain("ASM-006");
    expect(leads.get("WC-WIRING")).toBe("ASM-003");
  });

  it("keeps every pad inside its department, off aisles, walkways and other stations", () => {
    const clear = [...floorMarkings.aisles, ...floorMarkings.walkways];
    for (const id of new Set(leads.values())) {
      const station = factoryLayout.find((o) => o.id === id)!;
      const pad = bufferPad(station);
      const zone = departments.find((z) => z.id === station.department)!.bounds;
      expect(pad.minX >= zone.minX && pad.maxX <= zone.maxX && pad.minZ >= zone.minZ && pad.maxZ <= zone.maxZ, `${id} in zone`).toBe(true);
      for (const lane of clear) expect(overlaps(pad, lane), `${id} vs aisle`).toBe(false);
      for (const other of factoryLayout) expect(overlaps(pad, footprint(other)), `${id} pad vs ${other.id}`).toBe(false);
    }
  });

  it("places slots inside the pad, splitting it between the work centers a station leads", () => {
    const pad = bufferPad(factoryLayout.find((o) => o.id === "ASM-004")!);
    const slots = bufferSlots(pad, ["WC-CONTROLS", "WC-MOTOR"]);
    expect(slots).toHaveLength(BUFFER_SLOTS);
    for (const s of slots) {
      expect(s.x).toBeGreaterThan(pad.minX);
      expect(s.x).toBeLessThan(pad.maxX);
      expect(s.z).toBeGreaterThan(pad.minZ);
      expect(s.z).toBeLessThan(pad.maxZ);
    }
    expect(slots.filter((s) => s.workCenterId === "WC-MOTOR")).toHaveLength(BUFFER_SLOTS / 2);
  });
});

describe("queue semantics shared with the Work Centers table", () => {
  it("flags the same bottleneck and queue sizes as workCenterLoad", () => {
    const r = new FactoryReplay({ schemaVersion: d.manifest.schemaVersion, master: d.master, state: structuredClone(d.initialState) }, d.events);
    const t = Date.parse(d.initialState.asOf) + 9 * 24 * 3600_000;
    r.advanceToMs(t);
    const queues = workCenterQueues(r.state, d.master, t);
    const load = workCenterLoad({ asOfMs: t, startMs: Date.parse(d.initialState.asOf), master: d.master, state: r.state, events: r.appliedEvents() }, "7d");
    for (const q of queues) {
      const l = load.find((x) => x.workCenterId === q.workCenterId)!;
      expect(q.queue.length).toBe(l.queuedOrders);
      expect(q.isBottleneck).toBe(l.isBottleneck);
      expect(q.queue.reduce((n, s) => n + s.units, 0)).toBe(l.queuedUnits);
    }
    expect(queues.filter((q) => q.isBottleneck).length).toBeLessThanOrEqual(1);
  });
});

describe("shift awareness", () => {
  const start = Date.parse(d.initialState.asOf);
  const at = (ms: number) => {
    const r = new FactoryReplay({ schemaVersion: d.manifest.schemaVersion, master: d.master, state: structuredClone(d.initialState) }, d.events);
    r.advanceToMs(ms);
    return r.state;
  };

  it("never flags a bottleneck off shift, and flags one in shift when a queue exists", () => {
    let flaggedInShift = 0;
    for (let t = start; t < start + 10 * 24 * 3600_000; t += 3600_000) {
      const rows = workCenterQueues(at(t), d.master, t);
      if (!inShift(t)) {
        expect(rows.some((r) => r.isBottleneck), new Date(t).toISOString()).toBe(false);
        expect(rows.every((r) => !r.shiftOpen)).toBe(true);
      } else if (rows.some((r) => r.isBottleneck)) flaggedInShift++;
    }
    expect(flaggedInShift).toBeGreaterThan(0);
  });

  it("counts only shift minutes as waiting", () => {
    // Friday 17:00 -> Monday 07:00 is 1 h + 1 h of shift time, not 62 h.
    const fri = Date.UTC(2026, 8, 4, 17);
    const mon = Date.UTC(2026, 8, 7, 7);
    expect(shiftMinutesBetween(fri, mon)).toBe(120);
  });
});

describe("calendar helpers", () => {
  it("finds the next shift start and the weekday", () => {
    const fri18 = Date.UTC(2026, 8, 4, 18, 30);
    expect(weekdayShort(fri18)).toBe("Fri");
    expect(new Date(nextShiftStart(fri18)).toISOString()).toBe("2026-09-07T06:00:00.000Z");
    const mon05 = Date.UTC(2026, 8, 7, 5);
    expect(new Date(nextShiftStart(mon05)).toISOString()).toBe("2026-09-07T06:00:00.000Z");
    const mon10 = Date.UTC(2026, 8, 7, 10);
    expect(new Date(nextShiftStart(mon10)).toISOString()).toBe("2026-09-08T06:00:00.000Z");
  });
});
