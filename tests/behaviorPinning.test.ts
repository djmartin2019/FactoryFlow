/**
 * M0 behavior pinning (docs/SOURCE_INTEGRATION_PLAN_REV3.md, M0).
 *  - Accept/reject decision and exact error message for every corpus entry, committed as a file snapshot
 *    (tests/fixtures/behavior/corpus-decisions.json). Update it only for a deliberate rule change.
 *  - Every event of the canonical fixture and of the default dataset is accepted; the final-state hashes are pinned.
 *  - Differential check against the frozen legacy reducer (tests/legacy/state.ts). Identical today by construction;
 *    it becomes the guard for the M3a refactor.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fnv1a } from "../src/manufacturing/generator.ts";
import { applyEventInPlace } from "../src/manufacturing/state.ts";
import type { EventType, FactoryEvent, InitialStateFile } from "../src/manufacturing/types.ts";
import { dataset, observe } from "./helpers/atomicity.ts";
import { corpus } from "./helpers/atomicityCorpus.ts";
import { applyEventInPlace as legacyApplyEventInPlace } from "./legacy/state.ts";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "canonical");
const canonical: InitialStateFile = JSON.parse(readFileSync(join(fixtureDir, "initial_state.json"), "utf8"));
const canonicalEvents: FactoryEvent[] = JSON.parse(readFileSync(join(fixtureDir, "events.json"), "utf8"));

const TYPES = Object.keys(corpus) as EventType[];

function replayAll(initial: InitialStateFile, events: FactoryEvent[], reducer: typeof applyEventInPlace) {
  const state = structuredClone(initial.state);
  const decisions: string[] = [];
  for (const e of events) {
    try {
      reducer(state, e, initial.master);
      decisions.push("accept");
    } catch (err) {
      decisions.push(`reject: ${(err as Error).message}`);
    }
  }
  return { state, decisions };
}

describe("pinned decisions", () => {
  it("records decision, exact message and partial-mutation flag for every corpus entry", async () => {
    const rows = TYPES.flatMap((type) =>
      corpus[type].map((c) => {
        const out = observe(c.build());
        return out.decision === "accept"
          ? { type, name: c.name, decision: out.decision }
          : { type, name: c.name, decision: out.decision, message: out.message, mutatedBeforeThrow: out.mutated };
      }),
    );
    await expect(JSON.stringify(rows, null, 2) + "\n").toMatchFileSnapshot("./fixtures/behavior/corpus-decisions.json");
  });

  it("accepts every event of the canonical fixture and pins its final state", () => {
    const { state, decisions } = replayAll(canonical, canonicalEvents, applyEventInPlace);
    expect(decisions.every((d) => d === "accept")).toBe(true);
    expect(decisions).toHaveLength(72);
    expect(fnv1a(JSON.stringify(state))).toBe("becf2d1f");
  });

  it("accepts every event of the default dataset and pins its final state", () => {
    const d = dataset();
    const { state, decisions } = replayAll({ schemaVersion: d.manifest.schemaVersion, master: d.master, state: d.initialState }, d.events, applyEventInPlace);
    expect(decisions.every((x) => x === "accept")).toBe(true);
    expect(decisions).toHaveLength(d.events.length);
    expect(state).toEqual(d.finalState);
    expect(fnv1a(JSON.stringify(state))).toBe("5c4c0223");
  });
});

describe("differential against the frozen legacy reducer", () => {
  it("agrees on decision, message and resulting state for the canonical fixture", () => {
    const now = replayAll(canonical, canonicalEvents, applyEventInPlace);
    const old = replayAll(canonical, canonicalEvents, legacyApplyEventInPlace);
    expect(now.decisions).toEqual(old.decisions);
    expect(now.state).toEqual(old.state);
  });

  it("agrees on every corpus entry, including the state left behind after a rejection", () => {
    for (const type of TYPES) {
      for (const c of corpus[type]) {
        const a = c.build();
        const b = c.build();
        const outNow = observe(a, applyEventInPlace);
        const outOld = observe(b, legacyApplyEventInPlace);
        expect(outNow, `${type}: ${c.name}`).toEqual(outOld);
        // Until M3a this includes the half-mutated state; M3a must keep accepted-state parity only.
        if (outNow.decision === "accept") expect(a.state, `${type}: ${c.name}`).toEqual(b.state);
      }
    }
  });
});
