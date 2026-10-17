/**
 * Work-order elapsed time (slice S1b). Semantics: docs/KPI_DEFINITIONS.md, sections A and B of
 * "dispatch, lead time and work-order time", which are authoritative.
 *
 * A. Mutually exclusive categories: every instant of [createdAt, end) is in exactly one category, chosen by a
 *    state predicate over the order's own events (no precedence is needed on valid logs; precedence is only a
 *    deterministic safeguard and ties are counted). The categories sum to the elapsed time exactly.
 * B. Overlapping contributing conditions: indicative, never summed, never root causes. Equipment and backlog are
 *    current-state observations only.
 *
 * Durations are milliseconds so the identity is exact; callers round for display.
 */
import { DAY, HOUR, SHIFT_END_HOUR, SHIFT_START_HOUR, dayStart, isWorkingDay } from "../manufacturing/calendar.ts";
import type { FactoryEvent, Id, ProductionOperation } from "../manufacturing/types.ts";
import { workCenterQueues } from "./workCenters.ts";
import { workOrderEvents } from "./workOrders.ts";
import type { ReportingSnapshot } from "./types.ts";

export const TIME_CATEGORIES = [
  "PRE_RELEASE",
  "MATERIAL_BLOCKED",
  "HELD_MACHINE_DOWN",
  "PROCESSING",
  "QUEUE_WAIT",
  "OFF_SHIFT",
  "POST_PRODUCTION",
  "UNCLASSIFIED",
] as const;
export type TimeCategory = (typeof TIME_CATEGORIES)[number];

/** Safeguard order if two predicates ever hold at once (imported or corrupt data). Waiting covers QUEUE_WAIT and OFF_SHIFT. */
type Predicate = "HELD_MACHINE_DOWN" | "PROCESSING" | "MATERIAL_BLOCKED" | "WAIT" | "PRE_RELEASE" | "POST_PRODUCTION";
const PRECEDENCE: readonly Predicate[] = ["HELD_MACHINE_DOWN", "PROCESSING", "MATERIAL_BLOCKED", "WAIT", "PRE_RELEASE", "POST_PRODUCTION"];

export interface TimeInterval {
  startMs: number;
  endMs: number;
  category: TimeCategory;
}

export interface CurrentWaitState {
  /** Evaluation time; these are observations as of this instant, not durations. */
  asOfMs: number;
  workCenterName: string;
  /** 1 = first in the queue (oldest ready). */
  queuePosition: number;
  queuedOrders: number;
  queuedMinutes: number;
  queuedMinutesPerStation: number | null;
  /** Required equipment kinds with no free unit right now. */
  missingEquipment: string[];
}

export interface WorkOrderTime {
  orderId: Id;
  /** True while the order is not completed: `endMs` is then the snapshot time. */
  open: boolean;
  startMs: number;
  endMs: number;
  elapsedMs: number;
  totalsMs: Record<TimeCategory, number>;
  /** QUEUE_WAIT that ended in an operation start (the part comparable with the drawer's step Wait). */
  closedQueueWaitMs: number;
  /** QUEUE_WAIT of a wait still in progress at `endMs`. */
  openQueueWaitMs: number;
  /** Instants where more than one predicate held (resolved by precedence). Zero on any log the reducer accepts. */
  tieCount: number;
  /** completedAt - createdAt; null unless completed. */
  flowTimeMs: number | null;
  /** completedAt - releasedAt; null unless completed and released. */
  cycleTimeMs: number | null;
  /** B. Contributing conditions: independent measures that may overlap each other and the categories. Not additive. */
  conditions: {
    materialShortageMs: number;
    /** In-shift queue wait during which at least one station serving the waiting step's work center was down. */
    stationUnavailableMs: number;
    /** Applied setup minutes of started operations (inside PROCESSING). */
    changeoverSetupMinutes: number;
    changeovers: number;
    /** Setup minutes as a share of PROCESSING; null when there is no processing time. */
    setupShareOfProcessing: number | null;
    offShiftMs: number;
  };
  /** Equipment availability and backlog as of `endMs`, only while an operation is waiting right now. */
  currentWait: CurrentWaitState | null;
  intervals: TimeInterval[];
}

// ---- calendar helpers (exact, in ms) --------------------------------------

/** In-shift sub-intervals of [from, to), using the same working calendar as `calendar.ts`. */
function shiftIntervals(from: number, to: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let day = dayStart(from); day < to; day += DAY) {
    if (!isWorkingDay(day)) continue;
    const s = Math.max(from, day + SHIFT_START_HOUR * HOUR);
    const e = Math.min(to, day + SHIFT_END_HOUR * HOUR);
    if (e > s) out.push([s, e]);
  }
  return out;
}

function mergeIntervals(list: Array<[number, number]>): Array<[number, number]> {
  const sorted = list.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

function overlapMs(a: Array<[number, number]>, b: Array<[number, number]>): number {
  let total = 0;
  for (const [s1, e1] of a) for (const [s2, e2] of b) total += Math.max(0, Math.min(e1, e2) - Math.max(s1, s2));
  return total;
}

// ---- per-order state tracker ------------------------------------------------

interface OpState {
  id: Id;
  sequence: number;
  isRework: boolean;
  quantity: number;
  workCenterId?: Id;
  workstationKind: string;
  status: "PENDING" | "RUNNING" | "PAUSED" | "COMPLETED";
}

class Tracker {
  released = false;
  materialBlocked = false;
  machineBlocked = false;
  completed = false;
  cancelled = false;
  awaitingQc = 0;
  reworkPending = 0;
  readonly ops = new Map<Id, OpState>();

  private addOps(ops: readonly ProductionOperation[]): void {
    for (const o of ops) {
      this.ops.set(o.id, {
        id: o.id,
        sequence: o.sequence,
        isRework: o.isRework,
        quantity: o.quantity,
        workCenterId: o.workCenterId,
        workstationKind: o.workstationKind,
        status: "PENDING",
      });
    }
  }

  apply(e: FactoryEvent): void {
    switch (e.type) {
      case "PRODUCTION_ORDER_CREATED":
        this.addOps(e.payload.operations);
        break;
      case "PRODUCTION_ORDER_RELEASED":
        this.released = true;
        this.materialBlocked = false;
        break;
      case "PRODUCTION_ORDER_CANCELLED":
        this.cancelled = true;
        break;
      case "PRODUCTION_BLOCKED": {
        if (e.payload.reason === "MATERIAL_SHORTAGE") {
          this.materialBlocked = true;
        } else {
          this.machineBlocked = true;
          const target = e.payload.operationId ? this.ops.get(e.payload.operationId) : [...this.ops.values()].find((o) => o.status === "RUNNING");
          if (target && target.status === "RUNNING") target.status = "PAUSED";
        }
        break;
      }
      case "PRODUCTION_RESUMED": {
        this.machineBlocked = false;
        const op = this.ops.get(e.payload.operationId);
        if (op && op.status === "PAUSED") op.status = "RUNNING";
        break;
      }
      case "OPERATION_STARTED": {
        const op = this.ops.get(e.payload.productionOperationId);
        if (op) op.status = "RUNNING";
        break;
      }
      case "OPERATION_COMPLETED": {
        const op = this.ops.get(e.payload.productionOperationId);
        if (!op) break;
        op.status = "COMPLETED";
        if (op.isRework) {
          this.awaitingQc = op.quantity;
          this.reworkPending -= op.quantity;
        }
        break;
      }
      case "PRODUCTION_COMPLETED":
        this.awaitingQc = e.payload.quantityProduced;
        break;
      case "QUALITY_INSPECTION_COMPLETED":
        this.awaitingQc = 0;
        this.reworkPending = e.payload.inspection.reworkQuantity;
        break;
      case "REWORK_REQUESTED":
        this.addOps(e.payload.operations);
        break;
      case "FINISHED_GOODS_RECEIVED":
        this.completed = true;
        break;
      default:
        break;
    }
  }

  private statuses() {
    const all = [...this.ops.values()];
    return {
      all,
      running: all.some((o) => o.status === "RUNNING"),
      paused: all.some((o) => o.status === "PAUSED"),
      open: all.filter((o) => o.status !== "COMPLETED"),
    };
  }

  /** Predicates that hold in the current state, in precedence order. */
  predicates(): Predicate[] {
    const { all, running, paused, open } = this.statuses();
    if (this.completed || this.cancelled) return [];
    const blocked = this.materialBlocked || this.machineBlocked;
    const idle = !running && !paused;
    const held: Predicate[] = [];
    if (paused) held.push("HELD_MACHINE_DOWN");
    if (running) held.push("PROCESSING");
    if (this.materialBlocked) held.push("MATERIAL_BLOCKED");
    if (this.released && !blocked && idle && open.length > 0) held.push("WAIT");
    if (!this.released && !this.materialBlocked) held.push("PRE_RELEASE");
    if (this.released && !blocked && idle && all.length > 0 && open.length === 0 && this.reworkPending === 0 && this.awaitingQc === 0) held.push("POST_PRODUCTION");
    return held;
  }

  /** The next operation to start: the lowest-sequence open operation. */
  nextOperation(): OpState | undefined {
    return [...this.ops.values()].filter((o) => o.status !== "COMPLETED").sort((a, b) => a.sequence - b.sequence)[0];
  }
}

// ---- main ---------------------------------------------------------------------

interface Segment {
  startMs: number;
  endMs: number;
  /** Final category, or "WAIT" before the calendar split. */
  kind: Predicate | "UNCLASSIFIED";
  nextOp?: OpState;
}

export function workOrderTime(snapshot: ReportingSnapshot, orderId: Id): WorkOrderTime | null {
  const { state, master } = snapshot;
  const order = state.productionOrders[orderId];
  if (!order || order.status === "CANCELLED") return null;
  const events = workOrderEvents(snapshot, orderId);
  if (!events.some((e) => e.type === "PRODUCTION_ORDER_CREATED")) return null; // no creation event: history unavailable

  const startMs = Date.parse(order.createdAt);
  const completedMs = order.completedAt ? Date.parse(order.completedAt) : undefined;
  const open = order.status !== "COMPLETED";
  const endMs = open ? snapshot.asOfMs : completedMs!;

  // Boundaries are the distinct event timestamps; state is constant between them.
  const tracker = new Tracker();
  const segments: Segment[] = [];
  let tieCount = 0;
  const firstEventMs = Date.parse(events[0].timestamp);
  if (firstEventMs > startMs) segments.push({ startMs, endMs: Math.min(firstEventMs, endMs), kind: "UNCLASSIFIED" });

  for (let i = 0; i < events.length; ) {
    const ts = Date.parse(events[i].timestamp);
    while (i < events.length && Date.parse(events[i].timestamp) === ts) tracker.apply(events[i++]);
    const next = i < events.length ? Date.parse(events[i].timestamp) : endMs;
    const a = Math.max(ts, startMs);
    const b = Math.min(next, endMs);
    if (b <= a) continue;
    const held = tracker.predicates();
    if (held.length > 1) tieCount += 1;
    const chosen = PRECEDENCE.find((p) => held.includes(p));
    segments.push({ startMs: a, endMs: b, kind: chosen ?? "UNCLASSIFIED", nextOp: chosen === "WAIT" ? tracker.nextOperation() : undefined });
  }
  // The last event can precede the end of an open order; extend the final state to the end.
  const covered = segments.length ? segments[segments.length - 1].endMs : startMs;
  if (covered < endMs) {
    const held = tracker.predicates();
    const chosen = PRECEDENCE.find((p) => held.includes(p));
    segments.push({ startMs: covered, endMs, kind: chosen ?? "UNCLASSIFIED", nextOp: chosen === "WAIT" ? tracker.nextOperation() : undefined });
  }

  const totals = Object.fromEntries(TIME_CATEGORIES.map((c) => [c, 0])) as Record<TimeCategory, number>;
  const intervals: TimeInterval[] = [];
  const push = (startMs: number, endMs: number, category: TimeCategory) => {
    if (endMs <= startMs) return;
    totals[category] += endMs - startMs;
    intervals.push({ startMs, endMs, category });
  };

  // Split waiting by the calendar; remember in-shift waiting for the closed/open and station-unavailable measures.
  const inShiftWait: Array<{ seg: Segment; spans: Array<[number, number]>; index: number }> = [];
  segments.forEach((seg, index) => {
    if (seg.kind !== "WAIT") {
      push(seg.startMs, seg.endMs, seg.kind);
      return;
    }
    const spans = shiftIntervals(seg.startMs, seg.endMs);
    let cursor = seg.startMs;
    for (const [s, e] of spans) {
      push(cursor, s, "OFF_SHIFT");
      push(s, e, "QUEUE_WAIT");
      cursor = e;
    }
    push(cursor, seg.endMs, "OFF_SHIFT");
    inShiftWait.push({ seg, spans, index });
  });

  // A wait run is closed when the segment right after it is PROCESSING (it ended in an operation start).
  let closedQueueWaitMs = 0;
  let openQueueWaitMs = 0;
  for (const w of inShiftWait) {
    let j = w.index;
    while (j + 1 < segments.length && segments[j + 1].kind === "WAIT") j += 1;
    const closed = j + 1 < segments.length && segments[j + 1].kind === "PROCESSING";
    const ms = w.spans.reduce((n, [s, e]) => n + (e - s), 0);
    if (closed) closedQueueWaitMs += ms;
    else openQueueWaitMs += ms;
  }

  // B. Station unavailable: in-shift waiting while at least one station serving the next step's work center was down.
  let stationUnavailableMs = 0;
  for (const w of inShiftWait) {
    const op = w.seg.nextOp;
    if (!op) continue;
    const serving = master.workstations.filter((ws) => (op.workCenterId && ws.workCenterIds ? ws.workCenterIds.includes(op.workCenterId) : ws.kind === op.workstationKind)).map((ws) => ws.id);
    const down = mergeIntervals(
      Object.values(state.downtimes)
        .filter((d) => serving.includes(d.workstationId))
        .map((d): [number, number] => [Date.parse(d.failedAt), d.restoredAt ? Date.parse(d.restoredAt) : snapshot.asOfMs]),
    );
    stationUnavailableMs += overlapMs(w.spans, down);
  }

  // B. Changeover: applied setup minutes of this order's started operations (they sit inside PROCESSING).
  let changeoverSetupMinutes = 0;
  let changeovers = 0;
  for (const id of order.operationIds) {
    const op = state.productionOperations[id];
    if (!op?.startedAt) continue;
    changeoverSetupMinutes += op.setupMinutes ?? op.standardSetupMinutes ?? 0;
    if (op.changeoverFromProductId) changeovers += 1;
  }

  // B. Equipment and backlog: current-state observations only, and only while an operation is waiting right now.
  let currentWait: CurrentWaitState | null = null;
  if (open) {
    for (const wc of workCenterQueues(state, master, snapshot.asOfMs)) {
      const idx = wc.queue.findIndex((q) => q.productionOrderId === orderId);
      if (idx < 0) continue;
      currentWait = {
        asOfMs: snapshot.asOfMs,
        workCenterName: wc.name,
        queuePosition: idx + 1,
        queuedOrders: wc.queuedOrders,
        queuedMinutes: wc.queuedMinutes,
        queuedMinutesPerStation: wc.queuedMinutesPerStation,
        missingEquipment: wc.queue[idx].missingEquipment,
      };
      break;
    }
  }

  const releasedMs = order.releasedAt ? Date.parse(order.releasedAt) : undefined;
  const processing = totals.PROCESSING;
  return {
    orderId,
    open,
    startMs,
    endMs,
    elapsedMs: endMs - startMs,
    totalsMs: totals,
    closedQueueWaitMs,
    openQueueWaitMs,
    tieCount,
    flowTimeMs: completedMs === undefined ? null : completedMs - startMs,
    cycleTimeMs: completedMs === undefined || releasedMs === undefined ? null : completedMs - releasedMs,
    conditions: {
      materialShortageMs: totals.MATERIAL_BLOCKED,
      stationUnavailableMs,
      changeoverSetupMinutes,
      changeovers,
      setupShareOfProcessing: processing > 0 ? (changeoverSetupMinutes * 60_000) / processing : null,
      offShiftMs: totals.OFF_SHIFT,
    },
    currentWait,
    intervals,
  };
}
