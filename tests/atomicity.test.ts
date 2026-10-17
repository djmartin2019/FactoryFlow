/**
 * M0 atomicity harness (docs/SOURCE_INTEGRATION_PLAN_REV3.md, M0 and section 7.6).
 * Proves, on the in-place path, which event types can mutate state and then throw.
 */
import { describe, expect, it } from "vitest";
import type { EventType } from "../src/manufacturing/types.ts";
import { assertAtomicReject, observe } from "./helpers/atomicity.ts";
import { corpus } from "./helpers/atomicityCorpus.ts";

const TYPES = Object.keys(corpus) as EventType[];

/** Section 7.6 list as confirmed (or corrected) by this harness. */
const PARTIAL_TYPES: EventType[] = [
  "CUSTOMER_ORDER_CANCELLED",
  "FINISHED_GOODS_RECEIVED",
  "MACHINE_FAILED",
  "MATERIAL_CONSUMED",
  "MATERIAL_RECEIVED",
  "OPERATION_COMPLETED",
  "OPERATION_STARTED",
  "PRODUCTION_ORDER_CANCELLED",
  "PRODUCTION_ORDER_RELEASED",
  "REWORK_REQUESTED",
  "SHIPMENT_DISPATCHED",
];

describe("corpus coverage", () => {
  it("has at least one rejecting entry for every one of the 22 event types", () => {
    expect(TYPES).toHaveLength(22);
    for (const t of TYPES) {
      const rejecting = corpus[t].filter((c) => (c.expected ?? "reject") === "reject");
      expect(rejecting.length, t).toBeGreaterThan(0);
    }
  });

  it("covers every intra-event cumulative case of section 7.6", () => {
    const covered = new Set(TYPES.flatMap((t) => corpus[t].map((c) => c.cumulative)));
    for (const c of [
      "same-line shipments",
      "duplicate operation ids",
      "duplicate consumption entries",
      "shorted second reservation",
      "second equipment unit busy",
      "rework quantity underflow",
      "WIP not closing",
    ]) expect(covered.has(c), c).toBe(true);
  });
});

describe("atomic rejection oracle (in-place path)", () => {
  for (const t of TYPES) {
    for (const c of corpus[t].filter((e) => (e.expected ?? "reject") === "reject")) {
      const run = () => assertAtomicReject(c.build());
      // Known-partial entries pass only while the defect exists; M3a flips them to plain `it`.
      if (c.knownPartial) it.fails(`${t}: ${c.name} [known partial mutation]`, run);
      else it(`${t}: ${c.name}`, run);
    }
  }
});

describe("which event types mutate and then throw", () => {
  it("matches the section 7.6 list exactly", () => {
    const observed = new Set<EventType>();
    const falselyFlagged: string[] = [];
    for (const t of TYPES) {
      for (const c of corpus[t]) {
        const out = observe(c.build());
        if (out.decision === "reject" && out.mutated) observed.add(t);
        if (out.decision === "reject" && !out.mutated && c.knownPartial) falselyFlagged.push(`${t}: ${c.name}`);
        if (out.decision === "reject" && out.mutated && !c.knownPartial) falselyFlagged.push(`unflagged ${t}: ${c.name}`);
      }
    }
    expect(falselyFlagged).toEqual([]);
    expect([...observed].sort()).toEqual([...PARTIAL_TYPES].sort());
  });

  it("every entry decides as declared (reject unless pinned as accepted)", () => {
    for (const t of TYPES) {
      for (const c of corpus[t]) {
        expect(observe(c.build()).decision, `${t}: ${c.name}`).toBe(c.expected ?? "reject");
      }
    }
  });
});
