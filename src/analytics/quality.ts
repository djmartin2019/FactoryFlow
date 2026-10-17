/**
 * Quality, scrap and rework read model (slice S2). Semantics: docs/KPI_DEFINITIONS.md ("Quality, scrap and rework"),
 * which is authoritative. Built from `QualityInspection` records only; first-pass yield uses the same cohort and
 * window as the dashboard KPI, so the two agree exactly.
 */
import type { DefectCode, Id, QualityInspection } from "../manufacturing/types.ts";
import type { Rate } from "./dispatch.ts";
import { inWindow, periodWindow, type PeriodId, type PeriodWindow } from "./periods.ts";
import type { ReportingSnapshot } from "./types.ts";

export type CauseKind = "MACHINE_FAILURE" | "PROCESS_VARIATION" | "NOT_RECORDED";

/** Unit counts for the inspections of one group in the window. */
export interface QualityCounts {
  /** Inspections recorded in the window, all rounds. */
  inspections: number;
  /** Round 1 (first pass): units inspected, passed first time, sent to rework, scrapped. */
  firstInspected: number;
  firstPassed: number;
  firstRework: number;
  firstScrap: number;
  /** Round 2 (re-test after rework): units inspected, passed, scrapped. */
  retestInspected: number;
  retestPassed: number;
  retestScrap: number;
  /** All rounds. */
  failedUnits: number;
  scrapUnits: number;
}

export interface QualityRates {
  /** Round-1 passed / round-1 inspected. Same definition as the dashboard KPI. */
  firstPassYield: Rate;
  /** Round-1 units sent to rework / round-1 inspected. */
  reworkRate: Rate;
  /** Scrap units (all rounds, in window) / round-1 units inspected in window. */
  scrapRate: Rate;
  /** Re-test passed / re-tested units. N/A when nothing was re-tested in the window. */
  retestPassRate: Rate;
}

export interface QualityGroup extends QualityCounts, QualityRates {
  key: Id;
  label: string;
}

export interface ParetoEntry {
  code: DefectCode;
  quantity: number;
  /** Share of all defective units in the window (0..1). */
  share: number;
  cumulativeShare: number;
}

export interface QualityReport {
  asOfMs: number;
  window: PeriodWindow;
  overall: QualityCounts & QualityRates;
  byProduct: QualityGroup[];
  byStation: QualityGroup[];
  /** Defective units by defect code, largest first (ties by code). Sums to `overall.failedUnits`. */
  pareto: ParetoEntry[];
  /** Failed units by recorded cause. Units with no recorded cause are NOT_RECORDED, never assigned. Sums to failedUnits. */
  byCause: Array<{ cause: CauseKind; quantity: number }>;
}

const emptyCounts = (): QualityCounts => ({
  inspections: 0,
  firstInspected: 0,
  firstPassed: 0,
  firstRework: 0,
  firstScrap: 0,
  retestInspected: 0,
  retestPassed: 0,
  retestScrap: 0,
  failedUnits: 0,
  scrapUnits: 0,
});

function add(c: QualityCounts, i: QualityInspection): void {
  c.inspections += 1;
  c.failedUnits += i.failedQuantity;
  c.scrapUnits += i.scrapQuantity;
  if (i.round === 1) {
    c.firstInspected += i.inspectedQuantity;
    c.firstPassed += i.passedQuantity;
    c.firstRework += i.reworkQuantity;
    c.firstScrap += i.scrapQuantity;
  } else {
    c.retestInspected += i.inspectedQuantity;
    c.retestPassed += i.passedQuantity;
    c.retestScrap += i.scrapQuantity;
  }
}

const rate = (numerator: number, denominator: number): Rate => ({ numerator, denominator, rate: denominator === 0 ? null : numerator / denominator });

function rates(c: QualityCounts): QualityRates {
  return {
    firstPassYield: rate(c.firstPassed, c.firstInspected),
    reworkRate: rate(c.firstRework, c.firstInspected),
    scrapRate: rate(c.scrapUnits, c.firstInspected),
    retestPassRate: rate(c.retestPassed, c.retestInspected),
  };
}

export function qualityReport(snapshot: ReportingSnapshot, period: PeriodId): QualityReport {
  const { state, master, asOfMs, startMs } = snapshot;
  const window = periodWindow(period, asOfMs, startMs);
  const inspections = Object.values(state.qualityInspections)
    .filter((i) => inWindow(Date.parse(i.inspectedAt), window))
    .sort((a, b) => a.id.localeCompare(b.id));

  const overall = emptyCounts();
  const products = new Map<Id, QualityCounts>();
  const stations = new Map<Id, QualityCounts>();
  const defects = new Map<DefectCode, number>();
  const causes = new Map<CauseKind, number>();
  const bump = <K>(m: Map<K, QualityCounts>, key: K) => {
    let c = m.get(key);
    if (!c) m.set(key, (c = emptyCounts()));
    return c;
  };

  for (const i of inspections) {
    add(overall, i);
    const productId = state.productionOrders[i.productionOrderId]?.productId ?? "UNKNOWN";
    add(bump(products, productId), i);
    add(bump(stations, i.workstationId), i);
    for (const d of i.defects) defects.set(d.code, (defects.get(d.code) ?? 0) + d.quantity);
    if (i.failedQuantity > 0) {
      const cause: CauseKind = i.cause ? i.cause.kind : "NOT_RECORDED";
      causes.set(cause, (causes.get(cause) ?? 0) + i.failedQuantity);
    }
  }

  const group = (m: Map<Id, QualityCounts>, label: (id: Id) => string): QualityGroup[] =>
    [...m.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, c]) => ({ key, label: label(key), ...c, ...rates(c) }));

  const totalDefects = [...defects.values()].reduce((n, q) => n + q, 0);
  let running = 0;
  const pareto: ParetoEntry[] = [...defects.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([code, quantity]) => {
      running += quantity;
      return { code, quantity, share: quantity / totalDefects, cumulativeShare: running / totalDefects };
    });

  return {
    asOfMs,
    window,
    overall: { ...overall, ...rates(overall) },
    byProduct: group(products, (id) => {
      const p = master.products.find((x) => x.id === id);
      return p ? `${p.sku} ${p.name}` : id;
    }),
    byStation: group(stations, (id) => master.workstations.find((w) => w.id === id)?.name ?? id),
    pareto,
    byCause: (["MACHINE_FAILURE", "PROCESS_VARIATION", "NOT_RECORDED"] as const).map((cause) => ({ cause, quantity: causes.get(cause) ?? 0 })),
  };
}
