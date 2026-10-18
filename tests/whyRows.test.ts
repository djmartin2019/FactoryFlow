import { describe, expect, it } from "vitest";
import { bottleneckExplanations, explanationToShow, type ReportingSnapshot } from "../src/analytics/index.ts";
import { HOUR } from "../src/manufacturing/calendar.ts";
import { generateDataset } from "../src/manufacturing/generator.ts";
import { FactoryReplay } from "../src/manufacturing/replay.ts";
import { WHY_GROUP_TITLE, whyRows } from "../src/ui/explorer/whyRows.ts";
import { initialFileOf } from "./helpers/snapshot.ts";

const data = generateDataset();
const initial = initialFileOf(data);
const START = Date.parse(initial.state.asOf);

function* samples(): Generator<ReportingSnapshot> {
  const r = new FactoryReplay(structuredClone(initial), data.events);
  for (let h = 6; h < 30 * 24; h += 6) {
    const ms = START + h * HOUR;
    r.advanceToMs(ms);
    yield { asOfMs: ms, startMs: START, master: initial.master, state: r.state, events: r.appliedEvents() };
  }
}

describe("Why panel rows", () => {
  it("always gives the same seven conditions in the same fixed order, grouped by what they are measured over", () => {
    let n = 0;
    for (const s of samples()) {
      for (const period of ["24h", "all"] as const) {
        const e = explanationToShow(s, period);
        if (!e) continue;
        const rows = whyRows(e);
        expect(rows.map((r) => r.label)).toEqual(["Queue load", "Serving stations", "Equipment", "Station downtime", "Utilization", "Changeovers", "Material"]);
        expect(rows.map((r) => r.group)).toEqual(["current", "current", "current", "period", "period", "period", "plant"]);
        for (const r of rows) {
          expect(r.value.length).toBeGreaterThan(0);
          expect(r.detail.length).toBeGreaterThan(0);
        }
        n++;
      }
    }
    expect(n).toBeGreaterThan(20);
    expect(Object.keys(WHY_GROUP_TITLE).sort()).toEqual(["current", "period", "plant"]);
  });

  it("marks a condition present exactly when the underlying measure says so", () => {
    for (const s of samples()) {
      for (const e of bottleneckExplanations(s, "all")) {
        const byLabel = Object.fromEntries(whyRows(e).map((r) => [r.label, r]));
        expect(byLabel["Serving stations"].present).toBe(e.current.stationsDownNow.length > 0);
        expect(byLabel["Equipment"].present).toBe(e.current.waitingOnEquipment > 0);
        expect(byLabel["Changeovers"].present).toBe(e.period.changeovers > 0);
        expect(byLabel["Material"].present).toBe(e.plant.materialBlockedOrders > 0);
        expect(byLabel["Queue load"].present).toBeNull();
        expect(byLabel["Utilization"].present).toBeNull();
      }
    }
  });

  it("explains N/A instead of printing a bare 'N/A of ...' when the period has no shift time", () => {
    // A 24 h window ending early on a Monday contains no scheduled shift time.
    const r = new FactoryReplay(structuredClone(initial), data.events);
    const ms = Date.parse("2026-09-07T01:26:00Z");
    r.advanceToMs(ms);
    const s: ReportingSnapshot = { asOfMs: ms, startMs: START, master: initial.master, state: r.state, events: r.appliedEvents() };
    const e = explanationToShow(s, "24h")!;
    const rows = Object.fromEntries(whyRows(e).map((x) => [x.label, x]));
    expect(rows["Utilization"].value).toBe("N/A");
    expect(rows["Utilization"].detail).toMatch(/no scheduled shift time/);
    expect(rows["Station downtime"].value).toBe("N/A");
    expect(rows["Station downtime"].detail).toMatch(/choose a longer period/);
    for (const x of Object.values(rows)) expect(`${x.value} ${x.detail}`).not.toMatch(/N\/A of/);
  });

  it("never names a cause or combines the conditions", () => {
    for (const s of samples()) {
      const e = explanationToShow(s, "7d");
      if (!e) continue;
      const text = whyRows(e).map((r) => `${r.label} ${r.value} ${r.detail}`).join(" ").toLowerCase();
      expect(text).not.toMatch(/root cause|because of|caused by|due to the|score|total delay/);
    }
  });
});
