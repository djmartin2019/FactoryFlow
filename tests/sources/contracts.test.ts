/**
 * Type-level and shape tests for the M1 contracts. The `expectTypeOf` assertions are checked by `npm run typecheck`
 * (they are no-ops at runtime); the rest run under vitest.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildEvent } from "../../src/manufacturing/events.ts";
import type { EventPayloads, EventType, FactoryEvent, InitialStateFile } from "../../src/manufacturing/types.ts";
import {
  RULE_CLASSES,
  UNKNOWN,
  UNSUPPORTED,
  known,
  type BusinessEventInput,
  type CanonicalInput,
  type CdcChangeInput,
  type EventDraft,
  type InputKind,
  type InputProvenance,
  type Known,
  type SnapshotObservationInput,
  type SourceCapabilities,
  type StampedProvenance,
} from "../../src/sources/index.ts";

const provenance: InputProvenance = {
  sourceId: "sim", streamId: "sim", sourceEventId: "E-1", sourceOrdinal: 1,
  occurredAt: "2026-09-01T08:00:00.000Z", occurredAtQuality: "reported", observedAt: null,
  origin: "simulated_event", schemaVersion: "1.3.0", adapterVersion: "test", identityMapVersion: "v1",
  contentKey: "0000000000000000", rawRef: "mem:1",
};

/** Stand-in for M3b's `ingest`: its input type is the whole union. */
const ingest = (_input: CanonicalInput): void => {};

describe("CanonicalInput", () => {
  it("is accepted by ingest for all three input kinds (type level)", () => {
    const business: BusinessEventInput = {
      kind: "business_event",
      provenance,
      draft: { type: "MACHINE_RESTORED", timestamp: "2026-09-01T08:00:00.000Z", payload: { downtimeId: "DT-1", workstationId: "ASM-001" } },
    };
    const snapshot: SnapshotObservationInput = {
      kind: "snapshot_observation", provenance, entityType: "productionOrder", entityId: "WO.erp.1042",
      fields: { status: known("COMPLETE"), quantity: known(12), approvedQuantity: UNKNOWN, scrap: UNSUPPORTED },
    };
    const cdc: CdcChangeInput = {
      kind: "cdc_change", provenance, entityType: "productionOrder", entityId: "WO.erp.1042", operation: "update",
      before: { status: "OPEN" }, after: { status: "COMPLETE" },
    };
    for (const input of [business, snapshot, cdc]) ingest(input);

    expectTypeOf<CanonicalInput["kind"]>().toEqualTypeOf<InputKind>();
    expectTypeOf<CanonicalInput>().toEqualTypeOf<BusinessEventInput | SnapshotObservationInput | CdcChangeInput>();
  });

  it("only business events carry a draft that can reach the reducer (type level)", () => {
    expectTypeOf<BusinessEventInput["draft"]>().toEqualTypeOf<EventDraft>();
    expectTypeOf<EventDraft["type"]>().toEqualTypeOf<EventType>();
    expectTypeOf<SnapshotObservationInput>().not.toHaveProperty("draft");
    expectTypeOf<CdcChangeInput>().not.toHaveProperty("draft");
    // A draft's payload is exactly the domain payload for its type.
    expectTypeOf<Extract<EventDraft, { type: "SHIPMENT_DISPATCHED" }>["payload"]>().toEqualTypeOf<EventPayloads["SHIPMENT_DISPATCHED"]>();
  });

  it("narrows by `kind`", () => {
    const describeInput = (i: CanonicalInput): string => {
      switch (i.kind) {
        case "business_event": return i.draft.type;
        case "snapshot_observation": return `${i.entityType}:${Object.keys(i.fields).length}`;
        case "cdc_change": return i.operation;
        default: { const never: never = i; return never; }
      }
    };
    expect(describeInput({ kind: "cdc_change", provenance, entityType: "shipment", entityId: "S", operation: "delete" })).toBe("delete");
  });
});

describe("provenance", () => {
  it("has no ingestedAt until ingest stamps it", () => {
    expectTypeOf<InputProvenance>().not.toHaveProperty("ingestedAt");
    expectTypeOf<StampedProvenance>().toHaveProperty("ingestedAt");
    expect("ingestedAt" in provenance).toBe(false);
  });
});

describe("Known<T>", () => {
  it("keeps unknown, unsupported and known-zero distinct", () => {
    expect(known(0)).toEqual({ state: "known", value: 0 });
    expect(known(0)).not.toEqual(UNKNOWN);
    expect(UNKNOWN).not.toEqual(UNSUPPORTED);
    expectTypeOf(known(3)).toEqualTypeOf<Known<number>>();
  });
});

describe("capabilities", () => {
  it("describe the simulation per the plan (causal ordinals, no versioning)", () => {
    const sim: SourceCapabilities = {
      inputKinds: ["business_event"], entities: { productionOrder: "full" }, ordinal: "causal",
      versioning: "none", timePrecision: "ms", liveUpdates: false, historyQuery: true,
    };
    expect(sim.ordinal).toBe("causal");
  });

  it("five rule classes are declared", () => {
    expect(RULE_CLASSES).toEqual(["LOG", "REFERENCE", "INTEGRITY", "PLAN_CONFORMANCE", "AMBIGUOUS"]);
  });
});

describe("EventDraft is sufficient to rebuild the canonical log", () => {
  const dir = new URL("../fixtures/canonical/", import.meta.url);
  const initial: InitialStateFile = JSON.parse(readFileSync(new URL("initial_state.json", dir), "utf8"));
  const events: FactoryEvent[] = JSON.parse(readFileSync(new URL("events.json", dir), "utf8"));

  it("buildEvent(sequence, draft...) reproduces every fixture event, so ingest only has to assign sequence", () => {
    expect(initial.master).toBeDefined();
    for (const e of events) {
      const draft: EventDraft = { type: e.type, timestamp: e.timestamp, payload: e.payload } as EventDraft;
      const rebuilt = JSON.parse(JSON.stringify(buildEvent(e.sequence, draft.timestamp, draft.type, draft.payload as never)));
      expect(rebuilt, e.id).toEqual(e);
    }
  });
});
