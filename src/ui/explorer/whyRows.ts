import type { BottleneckExplanation } from "../../analytics/bottleneck";

/** What the contributing conditions are measured over: the moment shown, the reporting period, or the whole plant. */
export type WhyGroup = "current" | "period" | "plant";

export const WHY_GROUP_TITLE: Record<WhyGroup, string> = {
  current: "Right now",
  period: "Over the reporting period",
  plant: "Whole plant",
};

export interface WhyRow {
  group: WhyGroup;
  label: string;
  /** The headline figure for the row. */
  value: string;
  /** What it is made of and what it is compared with. */
  detail: string;
  /** True: the condition is present now. False: it is not. Null: the row is a measure, not a yes/no condition. */
  present: boolean | null;
}

const pct = (x: number | null): string => (x === null ? "N/A" : `${(x * 100).toFixed(0)}%`);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const NO_SHIFT = "no scheduled shift time in the reporting period yet (choose a longer period)";

/**
 * The conditions as table rows, in a fixed order that is not an order of importance. Pure text, no DOM, so the wording is testable.
 * The rows are independent observations: nothing here adds them up, ranks them or calls one a cause.
 */
export function whyRows(e: BottleneckExplanation): WhyRow[] {
  const c = e.current;
  const p = e.period;
  const rows: WhyRow[] = [];

  rows.push({
    group: "current",
    label: "Queue load",
    value: `${Math.round(c.queuedMinutesPerStation ?? 0)} min per station`,
    detail:
      `${plural(c.queuedOrders, "order")}, ${plural(c.queuedUnits, "unit")}, ${Math.round(c.queuedMinutes)} standard min across ${plural(c.stations, "station")}` +
      (c.nextHighestPerStation !== null ? `; next highest work center ${Math.round(c.nextHighestPerStation)}` : "") +
      (c.oldestWaitMinutes !== null ? `; longest wait ${c.oldestWaitMinutes} shift min` : ""),
    present: null,
  });
  rows.push({
    group: "current",
    label: "Serving stations",
    value: `${c.stationsRunningNow} of ${c.stations} running`,
    detail: c.stationsDownNow.length ? `Down now: ${c.stationsDownNow.map((s) => s.name).join(", ")}` : "None down",
    present: c.stationsDownNow.length > 0,
  });
  rows.push({
    group: "current",
    label: "Equipment",
    value: c.waitingOnEquipment > 0 ? `${plural(c.waitingOnEquipment, "step")} waiting` : "None waiting",
    detail: c.waitingOnEquipment > 0 ? `No free unit of ${c.missingEquipmentKinds.join(", ")}` : "Every queued step has the equipment it needs",
    present: c.waitingOnEquipment > 0,
  });
  rows.push({
    group: "period",
    label: "Station downtime",
    value: p.stationDowntimeShare === null ? "N/A" : `${Math.round(p.stationDowntimeMinutes)} shift min`,
    detail: p.stationDowntimeShare === null ? `Not available: ${NO_SHIFT}` : `${pct(p.stationDowntimeShare)} of the serving stations' shift time`,
    present: p.stationDowntimeShare === null ? null : p.stationDowntimeMinutes > 0,
  });
  rows.push({
    group: "period",
    label: "Utilization",
    value: pct(p.utilization),
    detail: p.utilization === null ? `Not available: ${NO_SHIFT}` : "Run time excluding failure holds, over the serving stations' shift time",
    present: null,
  });
  rows.push({
    group: "period",
    label: "Changeovers",
    value: `${Math.round(p.setupMinutes)} setup min`,
    detail: `${plural(p.changeovers, "changeover")}` + (p.setupShareOfBusy === null ? "" : `; ${pct(p.setupShareOfBusy)} of run time`),
    present: p.changeovers > 0,
  });
  rows.push({
    group: "plant",
    label: "Material",
    value: e.plant.materialBlockedOrders > 0 ? plural(e.plant.materialBlockedOrders, "order") + " held" : "None held",
    detail: e.plant.materialBlockedOrders > 0 ? "Held before release by a material shortage, so not in this queue yet" : "No order is held before release by a material shortage",
    present: e.plant.materialBlockedOrders > 0,
  });
  return rows;
}
