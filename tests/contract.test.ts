/**
 * Contract tests against a small committed fixture (tests/fixtures/canonical).
 *
 * The fixture is a hand-checkable 7-day run: 4 customer orders, 3 production
 * orders, 9 good units, one machine failure. It pins the data contract
 * (initial_state.json + events.json) independently of the generator, so a
 * change to event shapes, reducer rules or KPI semantics fails here with a
 * small, readable diff. Regenerate it only for an intentional contract change
 * (see tests/fixtures/canonical/README.md).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { factoryLayout } from "../src/data/factoryLayout.ts";
import { computeKpis, periodWindow } from "../src/manufacturing/dashboardMetrics.ts";
import { describeEvent } from "../src/manufacturing/eventFormat.ts";
import { entityRefsFor, eventIdFor } from "../src/manufacturing/events.ts";
import { generateDataset } from "../src/manufacturing/generator.ts";
import { factoryObjectsForEvent } from "../src/manufacturing/mapping.ts";
import { FactoryReplay, replayEvents } from "../src/manufacturing/replay.ts";
import { SCHEMA_VERSION } from "../src/manufacturing/types.ts";
import { replayWithGuard } from "../src/manufacturing/state.ts";
import type { EventType, FactoryEvent, InitialStateFile } from "../src/manufacturing/types.ts";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "canonical");
const initial: InitialStateFile = JSON.parse(readFileSync(join(dir, "initial_state.json"), "utf8"));
const events: FactoryEvent[] = JSON.parse(readFileSync(join(dir, "events.json"), "utf8"));

/** Exhaustive on purpose: adding an EventType fails compilation until it is listed here. */
const KNOWN_EVENT_TYPES: Record<EventType, true> = {
  PURCHASE_ORDER_CREATED: true,
  MATERIAL_RECEIVED: true,
  INVENTORY_TRANSFERRED: true,
  CUSTOMER_ORDER_CREATED: true,
  CUSTOMER_ORDER_CANCELLED: true,
  PRODUCTION_ORDER_CREATED: true,
  PRODUCTION_ORDER_RELEASED: true,
  PRODUCTION_ORDER_CANCELLED: true,
  PRODUCTION_BLOCKED: true,
  PRODUCTION_RESUMED: true,
  MATERIAL_CONSUMED: true,
  PRODUCTION_STARTED: true,
  OPERATION_STARTED: true,
  OPERATION_COMPLETED: true,
  PRODUCTION_COMPLETED: true,
  QUALITY_INSPECTION_COMPLETED: true,
  REWORK_REQUESTED: true,
  FINISHED_GOODS_RECEIVED: true,
  FINISHED_GOODS_ALLOCATED: true,
  SHIPMENT_DISPATCHED: true,
  MACHINE_FAILED: true,
  MACHINE_RESTORED: true,
};

const startMs = Date.parse(initial.state.asOf);
const endMs = Date.parse(events[events.length - 1].timestamp);

describe("fixture shape", () => {
  it("declares the current schema version", () => {
    expect(initial.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it("has a contiguous, chronological event log with derived ids", () => {
    events.forEach((e, i) => {
      expect(e.sequence).toBe(i + 1);
      expect(e.id).toBe(eventIdFor(e.sequence));
      if (i > 0) expect(Date.parse(e.timestamp)).toBeGreaterThanOrEqual(Date.parse(events[i - 1].timestamp));
      expect(KNOWN_EVENT_TYPES[e.type], `known type ${e.type}`).toBe(true);
    });
  });

  it("stores entity refs exactly as derived from the payload", () => {
    for (const e of events) {
      const derived = JSON.parse(JSON.stringify(entityRefsFor(e.type, e.payload as never)));
      expect(e.entities, e.id).toEqual(derived);
    }
  });

  it("covers every event type except cancellation and rework", () => {
    const seen = new Set(events.map((e) => e.type));
    const missing = (Object.keys(KNOWN_EVENT_TYPES) as EventType[]).filter((t) => !seen.has(t));
    expect(missing.sort()).toEqual(["CUSTOMER_ORDER_CANCELLED", "PRODUCTION_ORDER_CANCELLED", "REWORK_REQUESTED"]);
  });
});

describe("replay contract", () => {
  it("replays without invariant violations", () => {
    const { error } = replayWithGuard(initial.master, initial.state, events);
    expect(error).toBeUndefined();
  });

  it("leaves every production order completed with the expected yields", () => {
    const state = replayEvents(initial.master, initial.state, events);
    const orders = Object.values(state.productionOrders).map((o) => [o.id, o.status, o.finishedGoodsReceivedQuantity]);
    expect(orders).toEqual([
      ["WO-0001", "COMPLETED", 3],
      ["WO-0002", "COMPLETED", 4],
      ["WO-0003", "COMPLETED", 2],
    ]);
    expect(Object.keys(state.shipments)).toHaveLength(4);
    expect(state.asOf).toBe(events[events.length - 1].timestamp);
  });

  it("FactoryReplay stepping and seeking agree with a one-shot replay", () => {
    const expected = replayEvents(initial.master, initial.state, events);
    const stepped = new FactoryReplay(initial, events);
    while (!stepped.done) stepped.step();
    expect(stepped.state).toEqual(expected);

    const seeked = new FactoryReplay(initial, events);
    seeked.seekTo(events[events.length - 1].timestamp);
    expect(seeked.state).toEqual(expected);
    seeked.reset();
    expect(seeked.state).toEqual(initial.state);
  });
});

describe("KPI contract", () => {
  const kpis = () => {
    const state = replayEvents(initial.master, initial.state, events);
    return computeKpis(state, initial.master, periodWindow("all", endMs, startMs));
  };

  it("matches hand-checked values at the end of the run", () => {
    const k = kpis();
    expect(k.goodUnits.value).toBe(9);
    expect(k.wip.value).toBe(0);
    expect(k.activeOrders.value).toBe(0);
    expect(k.shortageBlocked.value).toBe(0);
    expect(k.firstPassYield).toMatchObject({ value: 1, numerator: 9, denominator: 9 });
    expect(k.utilization).toMatchObject({ numerator: 608, denominator: 6840 });
    expect(k.utilization.value).toBeCloseTo(608 / 6840, 10);
  });

  it("good units equal the sum of finished-goods receipts in the log", () => {
    const received = events.reduce(
      (sum, e) => sum + (e.type === "FINISHED_GOODS_RECEIVED" ? (e.payload as { quantity: number }).quantity : 0),
      0,
    );
    expect(kpis().goodUnits.value).toBe(received);
  });
});

describe("presentation contract", () => {
  it("every event is describable for the activity feed", () => {
    for (const e of events) {
      const entry = describeEvent(e, initial.master);
      expect(entry.type, e.id).toBe(e.type);
      expect(entry.text.length, e.id).toBeGreaterThan(0);
    }
  });

  it("every event maps only to objects that exist in the 3D layout", () => {
    const layoutIds = new Set(factoryLayout.map((o) => o.id));
    const replay = new FactoryReplay(initial, events);
    for (const e of events) {
      const before = structuredClone(replay.state) as never;
      replay.step();
      const { objectIds, flows } = factoryObjectsForEvent(e, before);
      for (const id of objectIds) expect(layoutIds.has(id), `${e.id} -> ${id}`).toBe(true);
      for (const f of flows) {
        if (f.from !== "EXTERNAL") expect(layoutIds.has(f.from), `${e.id} from ${f.from}`).toBe(true);
        if (f.to !== "EXTERNAL") expect(layoutIds.has(f.to), `${e.id} to ${f.to}`).toBe(true);
      }
    }
  });
});

describe("generator parity", () => {
  it("still reproduces the committed fixture byte for byte", () => {
    const d = generateDataset({
      seed: "fixture-v1",
      days: 7,
      customerOrders: 4,
      purchaseOrders: 4,
      customerCount: 2,
      assemblyWorkstations: 1,
      inspectionWorkstations: 1,
      machineFailuresPerWorkstation: 1,
      demandSurge: null,
    });
    expect(JSON.parse(JSON.stringify(d.events))).toEqual(events);
    expect(JSON.parse(JSON.stringify(d.initialState))).toEqual(initial.state);
    expect(d.manifest.eventLogHash).toBe("fc2a2149");
  });
});
