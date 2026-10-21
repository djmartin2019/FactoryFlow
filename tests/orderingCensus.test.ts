/**
 * M0 ordering characterization (docs/SOURCE_INTEGRATION_PLAN_REV3.md, M0 and Appendix B).
 * Events that share a timestamp are the norm in the simulation log, and the replayable order inside a tie is the
 * generator's `sequence`. This pins the census and proves that no global event-type rank can reproduce that order,
 * so nobody later "simplifies" source ordering to `(occurredAt, typeRank)`.
 */
import { describe, expect, it } from "vitest";
import type { EventType, FactoryEvent } from "../src/manufacturing/types.ts";
import { dataset } from "./helpers/atomicity.ts";

function tieGroups(events: readonly FactoryEvent[]): FactoryEvent[][] {
  const byTime = new Map<string, FactoryEvent[]>();
  for (const e of events) {
    const g = byTime.get(e.timestamp);
    if (g) g.push(e);
    else byTime.set(e.timestamp, [e]);
  }
  return [...byTime.values()];
}

/** Ordered (earlier, later) type pairs observed across all pairs of distinct-typed events inside tie groups. */
function orderedPairs(groups: FactoryEvent[][]): Map<string, number> {
  const pairs = new Map<string, number>();
  for (const g of groups) {
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        if (g[i].type === g[j].type) continue;
        const k = `${g[i].type}>${g[j].type}`;
        pairs.set(k, (pairs.get(k) ?? 0) + 1);
      }
    }
  }
  return pairs;
}

describe("tie census of the default dataset", () => {
  const events = dataset().events;
  const groups = tieGroups(events);
  const ties = groups.filter((g) => g.length > 1);

  it("is chronological with contiguous sequences, so sequence is the tie-breaker", () => {
    events.forEach((e, i) => {
      expect(e.sequence).toBe(i + 1);
      if (i > 0) expect(Date.parse(e.timestamp)).toBeGreaterThanOrEqual(Date.parse(events[i - 1].timestamp));
    });
  });

  // Appendix B "re-measured" column (seed larkhaven-2026, 0.1.0); the original column is the earlier northstar-2026 log.
  it("matches the Appendix B figures", () => {
    expect(events).toHaveLength(4455);
    expect(groups).toHaveLength(1299);
    expect(ties).toHaveLength(1106);
    expect(ties.reduce((n, g) => n + g.length, 0)).toBe(4262);
    expect(Math.max(...groups.map((g) => g.length))).toBe(21);
  });

  it("has event-type pairs that occur in both orders within ties, so no global type rank reproduces the order", () => {
    const pairs = orderedPairs(ties);
    const both: string[] = [];
    for (const k of pairs.keys()) {
      const [a, b] = k.split(">") as [EventType, EventType];
      if (a < b && pairs.has(`${b}>${a}`)) both.push(k);
    }
    expect(both.length).toBeGreaterThan(0);
    expect(both.length).toBe(41);

    // The two counts from Appendix B for one such pair.
    expect(pairs.get("OPERATION_COMPLETED>OPERATION_STARTED")).toBeGreaterThan(0);
    expect(pairs.get("OPERATION_STARTED>OPERATION_COMPLETED")).toBeGreaterThan(0);
  });

  it("any single type rank misorders at least one tie", () => {
    // For the best possible rank (the one that agrees with the majority of each pair), the minority still disagrees.
    const pairs = orderedPairs(ties);
    let minority = 0;
    for (const [k, n] of pairs) {
      const [a, b] = k.split(">");
      const rev = pairs.get(`${b}>${a}`) ?? 0;
      if (a < b && rev > 0) minority += Math.min(n, rev);
    }
    expect(minority).toBeGreaterThan(0);
  });
});
