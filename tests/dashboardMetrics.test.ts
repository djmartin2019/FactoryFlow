import { beforeAll, describe, expect, it } from "vitest";
import { DAY } from "../src/manufacturing/calendar.ts";
import { computeKpis, periodWindow, stationMetrics } from "../src/manufacturing/dashboardMetrics.ts";
import { ActivityLog, describeEvent } from "../src/manufacturing/eventFormat.ts";
import { generateDataset } from "../src/manufacturing/generator.ts";
import { FactoryReplay } from "../src/manufacturing/replay.ts";
import type { ManufacturingDataset } from "../src/manufacturing/types.ts";
import { SimulationController } from "../src/simulation/SimulationController.ts";

let data: ManufacturingDataset;
const initialFile = () => ({ schemaVersion: "1.0.0", master: data.master, state: data.initialState });
const startMs = () => Date.parse(data.initialState.asOf);
const endMs = () => Date.parse(data.finalState.asOf);

beforeAll(() => {
  data = generateDataset();
});

describe("KPIs", () => {
  it("are N/A or zero at simulation start, never fabricated", () => {
    const win = periodWindow("24h", startMs(), startMs());
    const k = computeKpis(data.initialState, data.master, win);
    expect(k.utilization.value).toBeNull();
    expect(k.utilization.display).toBe("N/A");
    expect(k.firstPassYield.value).toBeNull();
    expect(k.goodUnits.value).toBe(0);
    expect(k.wip.value).toBe(0);
  });

  it("over the whole run match independent sums over the final state", () => {
    const replay = new FactoryReplay(initialFile(), data.events);
    replay.advanceToMs(endMs());
    const s = replay.state;
    const win = periodWindow("all", endMs(), startMs());
    const k = computeKpis(s, data.master, win);

    const orders = Object.values(s.productionOrders);
    expect(k.goodUnits.value).toBe(orders.reduce((a, o) => a + o.finishedGoodsReceivedQuantity, 0));
    expect(k.wip.value).toBe(orders.reduce((a, o) => a + o.wipQuantity, 0));
    expect(k.activeOrders.value).toBe(orders.filter((o) => ["WAITING", "RUNNING", "BLOCKED"].includes(o.status)).length);
    expect(k.shortageBlocked.value).toBe(
      orders.filter((o) => o.status === "BLOCKED" && o.blockReason === "MATERIAL_SHORTAGE").length,
    );

    const first = Object.values(s.qualityInspections).filter((i) => i.round === 1);
    const inspected = first.reduce((a, i) => a + i.inspectedQuantity, 0);
    const passed = first.reduce((a, i) => a + i.passedQuantity, 0);
    expect(k.firstPassYield.value).toBeCloseTo(passed / inspected, 10);
    expect(k.firstPassYield.value!).toBeGreaterThan(0);
    expect(k.firstPassYield.value!).toBeLessThanOrEqual(1);
  });

  it("good units equals the sum of FINISHED_GOODS_RECEIVED events in the window", () => {
    const now = startMs() + 15 * DAY;
    const replay = new FactoryReplay(initialFile(), data.events);
    replay.advanceToMs(now);
    const win = periodWindow("7d", now, startMs());
    const k = computeKpis(replay.state, data.master, win);
    const expected = data.events
      .filter((e) => e.type === "FINISHED_GOODS_RECEIVED")
      .filter((e) => Date.parse(e.timestamp) > win.fromMs && Date.parse(e.timestamp) <= now)
      .reduce((a, e) => a + (e.type === "FINISHED_GOODS_RECEIVED" ? e.payload.quantity : 0), 0);
    expect(k.goodUnits.value).toBe(expected);
  });

  it("utilization is within 0..1 and per-station values are bounded", () => {
    const now = startMs() + 20 * DAY;
    const replay = new FactoryReplay(initialFile(), data.events);
    replay.advanceToMs(now);
    const win = periodWindow("7d", now, startMs());
    const stations = stationMetrics(replay.state, data.master, win);
    for (const s of stations) {
      expect(s.utilization).not.toBeNull();
      expect(s.utilization!).toBeGreaterThanOrEqual(0);
      expect(s.utilization!).toBeLessThanOrEqual(1);
    }
    const k = computeKpis(replay.state, data.master, win, stations);
    expect(k.utilization.value!).toBeGreaterThan(0);
  });

  it("reset restores the initial KPI values (no stale data)", () => {
    const sim = new SimulationController(initialFile(), data.events);
    const before = computeKpis(sim.state, data.master, periodWindow("all", sim.currentTime.getTime(), startMs()));
    sim.setSpeed(86400);
    sim.play();
    for (let i = 0; i < 400; i++) sim.update(1);
    expect(sim.engine.position).toBeGreaterThan(0);
    sim.reset();
    const after = computeKpis(sim.state, data.master, periodWindow("all", sim.currentTime.getTime(), startMs()));
    expect(after).toEqual(before);
    expect(sim.progress).toBe(0);
    expect(sim.isPlaying).toBe(false);
  });
});

describe("SimulationController", () => {
  it("seekTo moves the single clock and bumps the epoch; pause freezes state", () => {
    const sim = new SimulationController(initialFile(), data.events);
    const epoch = sim.epoch;
    sim.seekTo(startMs() + 10 * DAY);
    expect(sim.epoch).toBe(epoch + 1);
    expect(sim.currentTime.getTime()).toBe(startMs() + 10 * DAY);
    const seq = sim.state.lastSequence;
    sim.update(100); // paused: nothing may change
    expect(sim.state.lastSequence).toBe(seq);
    expect(sim.progress).toBeGreaterThan(0.3);
  });

  it("stops at the end of the dataset", () => {
    const sim = new SimulationController(initialFile(), data.events);
    sim.setSpeed(86400);
    sim.play();
    for (let i = 0; i < 100; i++) sim.update(1);
    expect(sim.isDone).toBe(true);
    expect(sim.isPlaying).toBe(false);
    expect(sim.progress).toBe(1);
  });
});

describe("ActivityLog / describeEvent", () => {
  it("describes every event type in the dataset without falling back to ids only", () => {
    for (const e of data.events) {
      const entry = describeEvent(e, data.master);
      expect(entry.text.length).toBeGreaterThan(3);
      expect(entry.type).toBe(e.type);
    }
  });

  it("stays bounded and clears when the epoch changes", () => {
    const log = new ActivityLog(50);
    const entries = data.events.slice(0, 500).map((e) => describeEvent(e, data.master));
    for (const entry of entries) log.push(entry, 0);
    expect(log.latest(1000)).toHaveLength(50);
    expect(log.latest(1)[0].id).toBe(entries[499].id);
    log.sync(1);
    expect(log.latest(10)).toHaveLength(0);
  });
});
