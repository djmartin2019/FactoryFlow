/**
 * M2: the simulation as a source. adapter(emit(x)) must reproduce x exactly (deep equality and byte-for-byte key order,
 * so JSON hashes of the log are unchanged), while the wire form must really differ from the domain form.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildEvent } from "../../src/manufacturing/events.ts";
import { fnv1a } from "../../src/manufacturing/generator.ts";
import type { FactoryEvent, InitialStateFile } from "../../src/manufacturing/types.ts";
import {
  EVENT_KINDS,
  SIM_ADAPTER_VERSION,
  SIM_CAPABILITIES,
  SIM_WIRE_VERSION,
  adaptEvent,
  adaptEvents,
  adaptInitialState,
  emitEvents,
  emitInitialState,
  simulationCodec,
  type WireEventRecord,
} from "../../src/sources/simulation/index.ts";
import { initialFileOf } from "../helpers/snapshot.ts";
import { dataset } from "../helpers/atomicity.ts";

const ctx = { identityMapVersion: "passthrough/1" };
const fixtureDir = new URL("../fixtures/canonical/", import.meta.url);
const fixtureInitial: InitialStateFile = JSON.parse(readFileSync(new URL("initial_state.json", fixtureDir), "utf8"));
const fixtureEvents: FactoryEvent[] = JSON.parse(readFileSync(new URL("events.json", fixtureDir), "utf8"));

/** Wire records as they would arrive over a network. */
const overTheWire = <T>(x: T): T => JSON.parse(JSON.stringify(x));

function adaptAll(events: FactoryEvent[]): FactoryEvent[] {
  const wires = overTheWire(emitEvents(events));
  const { inputs, issues } = adaptEvents(wires, ctx);
  expect(issues).toEqual([]);
  expect(inputs).toHaveLength(events.length);
  // What ingest does for a simulation: take the draft, stamp the sequence (here: the source ordinal) and build the event.
  return inputs.map((i) => buildEvent(i.provenance.sourceOrdinal as number, i.draft.timestamp, i.draft.type, i.draft.payload as never) as FactoryEvent);
}

describe("initial state and master data (2a)", () => {
  for (const [name, get] of [
    ["default dataset", () => initialFileOf(dataset())],
    ["canonical fixture", () => fixtureInitial],
  ] as const) {
    it(`round-trips the ${name} exactly, key order included`, () => {
      const initial = overTheWire(get());
      const wire = overTheWire(emitInitialState(initial));
      const r = adaptInitialState(wire);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value).toEqual(initial);
      expect(JSON.stringify(r.value)).toBe(JSON.stringify(initial));
    });
  }

  it("really converts: keys, units, timestamps, inventory rows", () => {
    const initial = initialFileOf(dataset());
    const wire = emitInitialState(initial);
    expect(wire.wire_version).toBe(SIM_WIRE_VERSION);
    const m = wire.master as Record<string, Record<string, unknown>[]>;
    expect(Object.keys(m)).toContain("bills_of_materials");
    expect(m.bills_of_materials[0].lines).toEqual(expect.arrayContaining([expect.objectContaining({ qty_per: expect.any(Number) })]));
    const step = (m.routings[0].steps as Record<string, unknown>[])[0];
    expect(step).toHaveProperty("setup_s");
    expect(step).not.toHaveProperty("setupMinutes");
    const domainStep = initial.master.routings[0].steps[0];
    expect(step.setup_s).toBe(domainStep.setupMinutes * 60);
    expect(step.s_per_unit).toBe(domainStep.minutesPerUnit * 60);
    const state = wire.state as Record<string, unknown>;
    expect(state.as_of).toBe("2026-09-01T00:00:00Z"); // explicit Z, no ".000"
    expect(Array.isArray(state.inventory)).toBe(true); // rows, not a keyed record
    expect(Object.values(state.workstations as Record<string, { status: string }>)[0].status).toBe("IDLE");
  });

  it("changeover and equipment sections survive (schema 1.3.0)", () => {
    const initial = initialFileOf(dataset());
    expect(initial.master.changeovers?.length).toBeGreaterThan(0);
    expect(initial.master.equipment?.length).toBeGreaterThan(0);
    const r = adaptInitialState(overTheWire(emitInitialState(initial)));
    expect(r.ok && r.value.master.changeovers).toEqual(initial.master.changeovers);
  });
});

describe("events (2b)", () => {
  it("round-trips every event of the default dataset, and the log hash is unchanged", () => {
    const d = dataset();
    const rebuilt = adaptAll(d.events);
    expect(rebuilt).toEqual(JSON.parse(JSON.stringify(d.events)));
    expect(fnv1a(JSON.stringify(rebuilt))).toBe(d.manifest.eventLogHash);
  });

  it("round-trips every event of the canonical fixture, and fixture hash 6ed76381 is unchanged", () => {
    const rebuilt = adaptAll(fixtureEvents);
    expect(rebuilt).toEqual(fixtureEvents);
    expect(fnv1a(JSON.stringify(rebuilt))).toBe("6ed76381");
  });

  it("covers every event type", () => {
    const d = dataset();
    const kinds = new Set(emitEvents(d.events).map((w) => w.event_kind));
    const missing = Object.values(EVENT_KINDS).filter((k) => !kinds.has(k));
    // The default dataset contains all 22 types; the kinds table is exhaustive and one-to-one.
    expect(missing).toEqual([]);
    expect(new Set(Object.values(EVENT_KINDS)).size).toBe(22);
  });

  it("every wire record carries a causal ordinal, a stream and a source-native id; no domain ids or entities", () => {
    const d = dataset();
    const wires = emitEvents(d.events);
    wires.forEach((w, i) => {
      expect(w.seq).toBe(d.events[i].sequence);
      expect(w.stream).toBe("sim");
      expect(w.event_id).toMatch(/^SIM-E\d{6}$/);
      expect(w.event_id).not.toBe(d.events[i].id);
      expect(Object.keys(w).sort()).toEqual(["event_id", "event_kind", "occurred_at", "payload", "seq", "stream"]);
    });
  });

  it("provenance: simulated origin, causal ordinal, versions, stable content key", () => {
    const d = dataset();
    const wires = emitEvents(d.events.slice(0, 50));
    const { inputs } = adaptEvents(wires, ctx);
    inputs.forEach((i, n) => {
      expect(i.kind).toBe("business_event");
      expect(i.provenance).toMatchObject({
        sourceId: "sim", streamId: "sim", sourceOrdinal: d.events[n].sequence, occurredAtQuality: "reported", observedAt: null,
        origin: "simulated_event", schemaVersion: SIM_WIRE_VERSION, adapterVersion: SIM_ADAPTER_VERSION, identityMapVersion: "passthrough/1",
      });
      expect(i.provenance.sourceEventId).toBe(wires[n].event_id);
      expect(i.provenance.contentKey).toMatch(/^[0-9a-f]{16}$/);
      expect(i.provenance.occurredAt).toBe(d.events[n].timestamp);
      expect(i.draft.timestamp).toBe(d.events[n].timestamp);
    });
    // Same record adapted twice (and with reordered payload keys) has the same content key.
    const a = adaptEvent(wires[3], ctx);
    const reordered = { ...wires[3], payload: Object.fromEntries(Object.entries(wires[3].payload).reverse()) };
    const b = adaptEvent(reordered, ctx);
    expect(a.ok && b.ok && a.value.provenance.contentKey).toBe(b.ok && b.value.provenance.contentKey);
  });

  it("really converts: the wire differs from the domain in names, units, status codes and timestamps", () => {
    const d = dataset();
    const wires = emitEvents(d.events);
    // Never identical to the domain record.
    d.events.forEach((e, i) => expect(JSON.stringify(wires[i].payload), e.id).not.toBe(JSON.stringify(e.payload)));

    const allKeys = new Set<string>();
    const walk = (v: unknown, keyed: boolean): void => {
      if (Array.isArray(v)) v.forEach((x) => walk(x, true));
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (keyed) allKeys.add(k); walk(x, true); }
    };
    wires.forEach((w) => walk(w.payload, true));
    // Keys are snake_case; the record-of-id dictionaries inside payloads are not used, so every key is a field name.
    for (const k of allKeys) expect(k, k).toMatch(/^[a-z][a-z0-9_]*$/);
    expect([...allKeys].some((k) => k.endsWith("_qty") || k === "qty")).toBe(true);
    expect([...allKeys].some((k) => k.endsWith("_s"))).toBe(true);

    // Seconds, not minutes.
    const started = d.events.findIndex((e) => e.type === "OPERATION_STARTED" && e.payload.setupMinutes !== undefined);
    const e = d.events[started] as Extract<FactoryEvent, { type: "OPERATION_STARTED" }>;
    expect(wires[started].payload.setup_s).toBe(e.payload.setupMinutes! * 60);
    expect(wires[started].payload).not.toHaveProperty("setupMinutes");

    // Status codes, not domain statuses.
    const created = d.events.findIndex((x) => x.type === "PRODUCTION_ORDER_CREATED");
    expect((wires[created].payload.production_order as { status: string }).status).toBe("PLN");

    // Timestamps: explicit Z, no ".000".
    for (const w of wires) {
      expect(w.occurred_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
      expect(JSON.stringify(w.payload)).not.toContain(".000Z");
    }
  });

  it("wire files stay within 1.5x of events.json (budget D7)", () => {
    const d = dataset();
    const domain = JSON.stringify(d.events).length;
    const wire = JSON.stringify(emitEvents(d.events)).length;
    expect(wire / domain).toBeLessThan(1.5);
  });

  it("declares what the simulation can say", () => {
    expect(SIM_CAPABILITIES).toMatchObject({ inputKinds: ["business_event"], ordinal: "causal", versioning: "none" });
  });
});

describe("the codec spec", () => {
  it("is exhaustive: every domain field of every emitted entity is covered (the emitter throws on a gap)", () => {
    // Covered by the round trips above; here, an unknown domain field is a loud error, not a dropped value.
    expect(() => simulationCodec.encode("Department", { id: "D", name: "n", kind: "k", surprise: 1 })).toThrow(/no wire mapping for Department\.surprise/);
  });

  it("derives wire names", () => {
    expect(simulationCodec.wireName("PurchaseOrderLine", "orderedQuantity")).toBe("ordered_qty");
    expect(simulationCodec.wireName("RoutingStep", "setupMinutes")).toBe("setup_s");
    expect(simulationCodec.wireName("ProductionOrder", "createdAt")).toBe("created_at");
  });
});

describe("negative cases: bad wire data yields issues, never a throw, never an input", () => {
  const d = dataset();
  const wires = emitEvents(d.events);
  const find = (kind: string): WireEventRecord => structuredClone(wires.find((w) => w.event_kind === kind)!);
  const bad = (w: unknown) => {
    const r = adaptEvent(w, ctx);
    expect(r.ok).toBe(false);
    return r.ok ? [] : r.issues;
  };

  it("missing field", () => {
    const w = find("production.operation_completed");
    delete (w.payload as Record<string, unknown>).workstation_id;
    expect(bad(w)).toEqual([expect.objectContaining({ code: "MISSING_FIELD", path: "payload.workstation_id", sourceRef: { sourceId: "sim", sourceEventId: w.event_id } })]);
  });

  it("unknown field", () => {
    const w = find("production.operation_completed");
    w.payload.surprise = 1;
    expect(bad(w)[0]).toMatchObject({ code: "UNKNOWN_FIELD", path: "payload.surprise" });
  });

  it("wrong unit: seconds that are not whole minutes", () => {
    const w = find("machine.failed");
    w.payload.expected_repair_s = 90;
    expect(bad(w)[0]).toMatchObject({ code: "BAD_UNIT", path: "payload.expected_repair_s" });
  });

  it("unknown status code, including a domain status used on the wire", () => {
    const w = find("production.order_created");
    (w.payload.production_order as Record<string, unknown>).status = "PLANNED";
    expect(bad(w)[0]).toMatchObject({ code: "UNKNOWN_CODE", path: "payload.production_order.status" });
  });

  it("bad timestamps: nested and envelope", () => {
    const a = find("purchasing.po_created");
    (a.payload.purchase_order as Record<string, unknown>).created_at = "2026-09-01 06:00";
    expect(bad(a)[0]).toMatchObject({ code: "BAD_TIMESTAMP", path: "payload.purchase_order.created_at" });
    const b = find("purchasing.po_created");
    b.occurred_at = "2026-02-31T00:00:00Z";
    expect(bad(b)[0]).toMatchObject({ code: "BAD_TIMESTAMP", path: "occurred_at" });
  });

  it("wrong types, bad envelope values, unknown kind, non-object payload", () => {
    const w = find("inventory.transferred");
    (w.payload.transfer as Record<string, unknown>).qty = "5";
    expect(bad(w)[0]).toMatchObject({ code: "WRONG_TYPE", path: "payload.transfer.qty" });
    expect(bad({ ...find("machine.restored"), stream: "erp" })[0]).toMatchObject({ path: "stream" });
    expect(bad({ ...find("machine.restored"), seq: 0 })[0]).toMatchObject({ code: "OUT_OF_RANGE", path: "seq" });
    expect(bad({ ...find("machine.restored"), event_kind: "machine.exploded" })[0]).toMatchObject({ code: "UNKNOWN_CODE", path: "event_kind" });
    expect(bad({ ...find("machine.restored"), payload: [] })[0]).toMatchObject({ code: "WRONG_TYPE", path: "payload" });
    expect(bad({ ...find("machine.restored"), payload: undefined })[0]).toMatchObject({ code: "WRONG_TYPE", path: "payload" });
  });

  it("an id that is not a valid canonical id", () => {
    const w = find("machine.restored");
    w.payload.downtime_id = "DT::1";
    expect(bad(w)[0]).toMatchObject({ code: "INVALID_VALUE", path: "payload.downtime_id" });
  });

  it("collects every problem of a record", () => {
    const w = find("production.operation_started");
    delete (w.payload as Record<string, unknown>).production_order_id;
    w.payload.setup_s = 7;
    w.payload.surprise = true;
    expect(bad(w).map((i) => i.code).sort()).toEqual(["BAD_UNIT", "MISSING_FIELD", "UNKNOWN_FIELD"]);
  });

  it("a bad record does not stop the batch, and its good neighbours still come through", () => {
    const batch = wires.slice(0, 5).map((w) => structuredClone(w));
    (batch[2].payload as Record<string, unknown>) = { nonsense: 1 };
    const { inputs, issues } = adaptEvents(batch, ctx);
    expect(inputs).toHaveLength(4);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => (i.sourceRef as { sourceEventId: string }).sourceEventId === batch[2].event_id)).toBe(true);
  });

  it("never throws, whatever it is handed", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const raw of [undefined, null, 0, "", [], {}, cyclic, Symbol("x"), 10n, NaN, { event_id: 1 }, { event_id: "x", payload: cyclic }]) {
      expect(() => adaptEvent(raw, ctx)).not.toThrow();
      expect(() => adaptInitialState(raw)).not.toThrow();
      expect(adaptEvent(raw, ctx).ok).toBe(false);
      expect(adaptInitialState(raw).ok).toBe(false);
    }
  });

  it("initial state: missing section, unknown code, duplicate stock row, wrong wire version", () => {
    const base = overTheWire(emitInitialState(initialFileOf(d)));
    const bad2 = (w: unknown) => {
      const r = adaptInitialState(w);
      expect(r.ok).toBe(false);
      return r.ok ? [] : r.issues;
    };
    const noLocations = structuredClone(base);
    delete noLocations.master.locations;
    expect(bad2(noLocations)[0]).toMatchObject({ code: "MISSING_FIELD", path: "master.locations" });

    const badCode = structuredClone(base);
    (Object.values(badCode.state.workstations as Record<string, { status: string }>)[0]).status = "RUNNING";
    expect(bad2(badCode)[0]).toMatchObject({ code: "UNKNOWN_CODE" });

    const dup = structuredClone(base);
    const rows = dup.state.inventory as unknown[];
    rows.push(structuredClone(rows[0]));
    expect(bad2(dup)[0]).toMatchObject({ code: "DUPLICATE_KEY", path: `state.inventory.${rows.length - 1}` });

    expect(bad2({ ...base, wire_version: "sim-wire/2" })[0]).toMatchObject({ path: "wire_version" });
  });
});
