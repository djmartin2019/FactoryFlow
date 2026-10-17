import { describe, expect, it } from "vitest";
import { periodWindow, qualityReport, type ReportingSnapshot } from "../src/analytics/index.ts";
import { DAY, HOUR } from "../src/manufacturing/calendar.ts";
import { computeKpis } from "../src/manufacturing/dashboardMetrics.ts";
import { generateDataset } from "../src/manufacturing/generator.ts";
import type { DefectCode, InitialStateFile, ProductionOrder, QualityInspection } from "../src/manufacturing/types.ts";
import { endSnapshot, initialFileOf, literalSnapshot, snapshotAt } from "./helpers/snapshot.ts";

const data = generateDataset();
const initial: InitialStateFile = initialFileOf(data);
const [P1, P2] = initial.master.products;
const D0 = Date.parse("2026-09-01T00:00:00.000Z");
const at = (days: number, hours = 0) => D0 + days * DAY + hours * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

interface InspSpec {
  id: string;
  order: string;
  ms: number;
  round?: number;
  station?: string;
  inspected: number;
  failed?: number;
  rework?: number;
  defects?: Array<[DefectCode, number]>;
  cause?: QualityInspection["cause"];
}

const insp = (s: InspSpec): QualityInspection => {
  const failed = s.failed ?? 0;
  const rework = s.rework ?? 0;
  return {
    id: s.id,
    productionOrderId: s.order,
    operationId: `OP-${s.id}`,
    workstationId: s.station ?? "QC-001",
    round: s.round ?? 1,
    inspectedAt: iso(s.ms),
    inspectedQuantity: s.inspected,
    passedQuantity: s.inspected - failed,
    failedQuantity: failed,
    reworkQuantity: rework,
    scrapQuantity: failed - rework,
    defects: (s.defects ?? []).map(([code, quantity]) => ({ code, quantity })),
    cause: s.cause,
  };
};

function snap(asOfMs: number, inspections: QualityInspection[]): ReportingSnapshot {
  const order = (id: string, productId: string) => ({ ...Object.values(initial.state.productionOrders)[0], id, productId }) as ProductionOrder;
  const state = {
    ...initial.state,
    productionOrders: { A: order("A", P1.id), B: order("B", P2.id) },
    qualityInspections: Object.fromEntries(inspections.map((i) => [i.id, i])),
  };
  return literalSnapshot(initial, { asOfMs, events: [], state, startMs: D0 });
}

describe("quality report (hand-built inspections)", () => {
  const list = [
    insp({ id: "Q1", order: "A", ms: at(1), inspected: 10, failed: 3, rework: 2, defects: [["WIRING_ERROR", 2], ["ENCLOSURE_DAMAGE", 1]], cause: { kind: "MACHINE_FAILURE", downtimeId: "DT" } }),
    insp({ id: "Q2", order: "A", ms: at(2), round: 2, inspected: 2, failed: 1, rework: 0, defects: [["LOOSE_TERMINATION", 1]] }),
    insp({ id: "Q3", order: "B", ms: at(2), station: "QC-002", inspected: 20, failed: 2, rework: 2, defects: [["WIRING_ERROR", 2]], cause: { kind: "PROCESS_VARIATION" } }),
    insp({ id: "Q4", order: "B", ms: at(3), station: "QC-002", inspected: 5 }),
  ];
  const r = qualityReport(snap(at(4), list), "all");

  it("computes first-pass yield, rework and scrap rates on round-1 units", () => {
    // round 1: inspected 10 + 20 + 5 = 35, passed 7 + 18 + 5 = 30, rework 2 + 2, scrap (round 1) 1
    expect(r.overall.firstInspected).toBe(35);
    expect(r.overall.firstPassYield).toEqual({ numerator: 30, denominator: 35, rate: 30 / 35 });
    expect(r.overall.reworkRate).toEqual({ numerator: 4, denominator: 35, rate: 4 / 35 });
    // scrap: round 1 = 1, round 2 = 1, over round-1 inspected
    expect(r.overall.scrapUnits).toBe(2);
    expect(r.overall.scrapRate).toEqual({ numerator: 2, denominator: 35, rate: 2 / 35 });
  });

  it("measures re-test pass rate on re-tested units only", () => {
    expect(r.overall.retestPassRate).toEqual({ numerator: 1, denominator: 2, rate: 0.5 });
  });

  it("groups by product and by station, and the groups add up to the overall counts", () => {
    expect(r.byProduct.map((g) => g.key)).toEqual([P1.id, P2.id]);
    expect(r.byStation.map((g) => g.key)).toEqual(["QC-001", "QC-002"]);
    for (const groups of [r.byProduct, r.byStation]) {
      for (const f of ["inspections", "firstInspected", "firstPassed", "firstRework", "firstScrap", "retestInspected", "retestPassed", "retestScrap", "failedUnits", "scrapUnits"] as const) {
        expect(groups.reduce((n, g) => n + g[f], 0), f).toBe(r.overall[f]);
      }
    }
  });

  it("orders the defect Pareto and its cumulative share, summing to the failed units", () => {
    expect(r.pareto.map((p) => [p.code, p.quantity])).toEqual([["WIRING_ERROR", 4], ["ENCLOSURE_DAMAGE", 1], ["LOOSE_TERMINATION", 1]]);
    expect(r.pareto[0].share).toBeCloseTo(4 / 6);
    expect(r.pareto.at(-1)!.cumulativeShare).toBeCloseTo(1);
    expect(r.pareto.reduce((n, p) => n + p.quantity, 0)).toBe(r.overall.failedUnits);
  });

  it("attributes failed units only to recorded causes and reports the rest as not recorded", () => {
    expect(r.byCause).toEqual([
      { cause: "MACHINE_FAILURE", quantity: 3 },
      { cause: "PROCESS_VARIATION", quantity: 2 },
      { cause: "NOT_RECORDED", quantity: 1 },
    ]);
    expect(r.byCause.reduce((n, c) => n + c.quantity, 0)).toBe(r.overall.failedUnits);
  });

  it("applies the half-open reporting window (from, to] to inspection time", () => {
    // as of day 9 the 7-day window is (day 2, day 9]: Q2 and Q3 at exactly day 2 are out, Q4 at day 3 is in
    const week = qualityReport(snap(at(9), list), "7d");
    expect(week.overall.inspections).toBe(1);
    expect(week.overall.firstInspected).toBe(5);
    // as of day 10 the window is (day 3, day 10]: Q4 at exactly day 3 is out
    expect(qualityReport(snap(at(10), list), "7d").overall.inspections).toBe(0);
  });

  it("returns N/A, not 0, when there is nothing to divide by", () => {
    const none = qualityReport(snap(at(4), []), "all");
    expect(none.overall.firstPassYield.rate).toBeNull();
    expect(none.overall.reworkRate.rate).toBeNull();
    expect(none.overall.scrapRate.rate).toBeNull();
    expect(none.overall.retestPassRate.rate).toBeNull();
    expect(none.pareto).toEqual([]);
    expect(none.byProduct).toEqual([]);
    // scrap with no round-1 denominator in the window stays N/A but the scrap count is still shown
    const only2 = qualityReport(snap(at(4), [insp({ id: "R", order: "A", ms: at(1), round: 2, inspected: 2, failed: 1 })]), "all");
    expect(only2.overall.scrapUnits).toBe(1);
    expect(only2.overall.scrapRate.rate).toBeNull();
    expect(only2.overall.firstPassYield.rate).toBeNull();
  });

  it("reports zero defects as an empty Pareto with a defined yield of 100%", () => {
    const clean = qualityReport(snap(at(4), [insp({ id: "C", order: "A", ms: at(1), inspected: 8 })]), "all");
    expect(clean.overall.firstPassYield.rate).toBe(1);
    expect(clean.pareto).toEqual([]);
    expect(clean.overall.scrapRate.rate).toBe(0);
  });
});

describe("quality report on the default dataset", () => {
  const end = endSnapshot(initial, data.events);

  it("agrees with the dashboard first-pass yield in every reporting period", () => {
    for (const period of ["24h", "7d", "all"] as const) {
      for (const snapshot of [end, snapshotAt(initial, data.events, Date.parse(initial.state.asOf) + 15 * DAY)]) {
        const kpi = computeKpis(snapshot.state, snapshot.master, periodWindow(period, snapshot.asOfMs, snapshot.startMs)).firstPassYield;
        const fpy = qualityReport(snapshot, period).overall.firstPassYield;
        expect(fpy.rate, period).toBe(kpi.value);
        expect(fpy.numerator, period).toBe(kpi.numerator);
        expect(fpy.denominator, period).toBe(kpi.denominator);
      }
    }
  });

  it("reconciles all-time totals with the work orders and the inspection records", () => {
    const r = qualityReport(end, "all");
    const orders = Object.values(end.state.productionOrders);
    expect(r.overall.scrapUnits).toBe(orders.reduce((n, o) => n + o.scrappedQuantity, 0));
    const all = Object.values(end.state.qualityInspections);
    expect(r.overall.inspections).toBe(all.length);
    expect(r.overall.failedUnits).toBe(all.reduce((n, i) => n + i.failedQuantity, 0));
    expect(r.pareto.reduce((n, p) => n + p.quantity, 0)).toBe(r.overall.failedUnits);
    expect(r.byCause.reduce((n, c) => n + c.quantity, 0)).toBe(r.overall.failedUnits);
    // every failed unit is either reworked or scrapped in the round it failed
    expect(r.overall.failedUnits).toBe(r.overall.firstRework + r.overall.scrapUnits);
    for (const groups of [r.byProduct, r.byStation]) {
      expect(groups.reduce((n, g) => n + g.firstInspected, 0)).toBe(r.overall.firstInspected);
      expect(groups.reduce((n, g) => n + g.scrapUnits, 0)).toBe(r.overall.scrapUnits);
    }
  });

  it("is deterministic and does not mutate the snapshot", () => {
    const before = JSON.stringify(end.state.qualityInspections);
    expect(qualityReport(end, "7d")).toEqual(qualityReport(end, "7d"));
    expect(JSON.stringify(end.state.qualityInspections)).toBe(before);
  });
});
