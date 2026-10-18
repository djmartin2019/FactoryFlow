import { describe, expect, it } from "vitest";
import { bottleneckExplanations, explanationToShow, flaggedBottleneck, workCenterLoad, workCenterQueues, type ReportingSnapshot } from "../src/analytics/index.ts";
import { HOUR, shiftMinutesBetween } from "../src/manufacturing/calendar.ts";
import { generateDataset } from "../src/manufacturing/generator.ts";
import { FactoryReplay } from "../src/manufacturing/replay.ts";
import type { Downtime, InitialStateFile } from "../src/manufacturing/types.ts";
import { initialFileOf, snapshotAt } from "./helpers/snapshot.ts";

const data = generateDataset();
const initial: InitialStateFile = initialFileOf(data);
const START = Date.parse(initial.state.asOf);
const at = (iso: string) => Date.parse(iso);

// Instants found by scanning the default dataset hourly (seed northstar-2026); the scan test below guards the assumption.
const WITH_EQUIPMENT_WAIT = at("2026-09-01T15:00:00.000Z");
const WITH_STATION_DOWN = at("2026-09-08T11:00:00.000Z");
const WITH_BOTH = at("2026-09-10T17:00:00.000Z");

const flagged = (s: ReportingSnapshot) => bottleneckExplanations(s, "all").find((e) => e.flagged);

describe("bottleneck explanation: contributing conditions", () => {
  it("shows an equipment wait as a current-state observation naming the missing kinds", () => {
    const s = snapshotAt(initial, data.events, WITH_EQUIPMENT_WAIT);
    const e = flagged(s)!;
    expect(e.current.waitingOnEquipment).toBeGreaterThan(0);
    expect(e.current.missingEquipmentKinds.length).toBeGreaterThan(0);
    const q = workCenterQueues(s.state, s.master, s.asOfMs).find((w) => w.workCenterId === e.workCenterId)!;
    expect(e.current.waitingOnEquipment).toBe(q.waitingOnEquipment);
    expect(e.current.missingEquipmentKinds).toEqual([...new Set(q.queue.flatMap((x) => x.missingEquipment))].sort());
    expect(e.asOfMs).toBe(s.asOfMs);
  });

  it("shows a serving station that is down now", () => {
    const e = flagged(snapshotAt(initial, data.events, WITH_STATION_DOWN))!;
    expect(e.current.stationsDownNow.length).toBeGreaterThan(0);
    expect(e.current.stations).toBeGreaterThanOrEqual(e.current.stationsDownNow.length + e.current.stationsRunningNow);
  });

  it("shows two overlapping conditions side by side without combining them", () => {
    const e = flagged(snapshotAt(initial, data.events, WITH_BOTH))!;
    expect(e.current.waitingOnEquipment).toBeGreaterThan(0);
    expect(e.current.stationsDownNow.length).toBeGreaterThan(0);
    // The conditions are separate fields with their own units; there is no combined score, share-of-cause or ranking of conditions.
    expect(Object.keys(e.current)).not.toContain("score");
    expect(Object.keys(e)).not.toContain("rootCause");
    expect(Object.keys(e.period)).not.toContain("score");
  });

  it("measures station downtime in the period as shift minutes, from a constructed outage", () => {
    const base = snapshotAt(initial, data.events, WITH_EQUIPMENT_WAIT + 2 * HOUR); // a Tuesday inside the shift
    const wc = flagged(base)!;
    const station = base.master.workstations.find((w) => w.workCenterIds?.includes(wc.workCenterId))!;
    const state = structuredClone(base.state);
    const failedAt = base.asOfMs - 3 * HOUR;
    const outage: Downtime = { id: "DT-TEST", workstationId: station.id, failureCode: "TEST", failedAt: new Date(failedAt).toISOString(), expectedRepairMinutes: 60 };
    state.downtimes["DT-TEST"] = outage; // still open: runs to asOf
    state.workstations[station.id] = { ...state.workstations[station.id], status: "DOWN" };
    const before = bottleneckExplanations(base, "all").find((e) => e.workCenterId === wc.workCenterId)!;
    const after = bottleneckExplanations({ ...base, state }, "all").find((e) => e.workCenterId === wc.workCenterId)!;
    const added = after.period.stationDowntimeMinutes - before.period.stationDowntimeMinutes;
    expect(added).toBeCloseTo(shiftMinutesBetween(failedAt, base.asOfMs), 6);
    expect(after.current.stationsDownNow.map((s) => s.id)).toContain(station.id);
    expect(after.period.stationDowntimeShare).toBeGreaterThan(before.period.stationDowntimeShare ?? 0);
  });

  it("reports setup and utilization consistent with the Work Centers table", () => {
    const s = snapshotAt(initial, data.events, WITH_BOTH);
    const loads = new Map(workCenterLoad(s, "all").map((l) => [l.workCenterId, l]));
    for (const e of bottleneckExplanations(s, "all")) {
      const l = loads.get(e.workCenterId)!;
      expect(e.period.utilization).toBe(l.utilization);
      expect(e.period.setupMinutes).toBe(l.setupMinutes);
      expect(e.period.changeovers).toBe(l.changeovers);
      expect(e.period.busyMinutes).toBe(l.busyMinutes);
      if (l.busyMinutes > 0) expect(e.period.setupShareOfBusy).toBeCloseTo(l.setupMinutes / l.busyMinutes, 9);
    }
  });
});

describe("bottleneck explanation: invariants over the run", () => {
  it("flags at most one work center, only in shift, and it ranks first by queued minutes per station", () => {
    const r = new FactoryReplay(structuredClone(initial), data.events);
    let flaggedCount = 0;
    let offShiftChecked = 0;
    for (let h = 6; h < 30 * 24; h += 6) {
      const ms = START + h * HOUR;
      r.advanceToMs(ms);
      const s: ReportingSnapshot = { asOfMs: ms, startMs: START, master: initial.master, state: r.state, events: r.appliedEvents() };
      const all = bottleneckExplanations(s, "7d");
      const f = all.filter((e) => e.flagged);
      expect(f.length, new Date(ms).toISOString()).toBeLessThanOrEqual(1);
      if (!all[0].shiftOpen) {
        expect(f.length).toBe(0);
        expect(flaggedBottleneck(s, "7d")).toBeNull();
        offShiftChecked++;
      }
      for (const e of f) {
        flaggedCount++;
        expect(e.current.rank).toBe(1);
        expect(e.current.queuedMinutesPerStation!).toBeGreaterThanOrEqual(e.current.nextHighestPerStation ?? 0);
        expect(e.current.stationsDownNow.length + e.current.stationsRunningNow).toBeLessThanOrEqual(e.current.stations);
      }
      for (const e of all) expect(e.plant.materialBlockedOrders).toBe(all[0].plant.materialBlockedOrders);
    }
    expect(flaggedCount).toBeGreaterThan(10);
    expect(offShiftChecked).toBeGreaterThan(0);
  });

  it("is deterministic and does not mutate the snapshot", () => {
    const s = snapshotAt(initial, data.events, WITH_BOTH);
    const before = JSON.stringify(s.state.workstations) + JSON.stringify(s.state.downtimes);
    expect(bottleneckExplanations(s, "7d")).toEqual(bottleneckExplanations(s, "7d"));
    expect(JSON.stringify(s.state.workstations) + JSON.stringify(s.state.downtimes)).toBe(before);
  });
});

describe("bottleneck explanation shown by the Why panel", () => {
  it("is the flagged work center in shift, and the largest queue (not flagged) off shift", () => {
    const r = new FactoryReplay(structuredClone(initial), data.events);
    let inShiftChecked = 0;
    let offShiftChecked = 0;
    for (let h = 6; h < 30 * 24; h += 6) {
      const ms = START + h * HOUR;
      r.advanceToMs(ms);
      const s: ReportingSnapshot = { asOfMs: ms, startMs: START, master: initial.master, state: r.state, events: r.appliedEvents() };
      const all = bottleneckExplanations(s, "7d");
      const shown = explanationToShow(s, "7d");
      const withQueue = all.filter((e) => e.current.queuedOrders > 0);
      if (all[0].shiftOpen) {
        expect(shown?.workCenterId).toBe(flaggedBottleneck(s, "7d")?.workCenterId);
        if (shown) expect(shown.flagged).toBe(true);
        inShiftChecked++;
      } else if (withQueue.length > 0) {
        expect(shown, new Date(ms).toISOString()).not.toBeNull();
        expect(shown!.flagged).toBe(false);
        const max = Math.max(...withQueue.map((e) => e.current.queuedMinutesPerStation ?? 0));
        expect(shown!.current.queuedMinutesPerStation).toBe(max);
        expect(flaggedBottleneck(s, "7d")).toBeNull();
        offShiftChecked++;
      } else {
        expect(shown).toBeNull();
      }
    }
    expect(inShiftChecked).toBeGreaterThan(10);
    expect(offShiftChecked).toBeGreaterThan(3);
  });
});

