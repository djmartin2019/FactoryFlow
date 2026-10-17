import { describe, expect, it } from "vitest";
import {
  TIME_CATEGORIES,
  workOrderDetail,
  workOrderTime,
  type ReportingSnapshot,
  type TimeCategory,
} from "../src/analytics/index.ts";
import { HOUR, MIN, shiftMinutesBetween } from "../src/manufacturing/calendar.ts";
import { buildEvent } from "../src/manufacturing/events.ts";
import { generateDataset } from "../src/manufacturing/generator.ts";
import type { Downtime, FactoryEvent, InitialStateFile, ProductionOperation, ProductionOrder } from "../src/manufacturing/types.ts";
import { endSnapshot, initialFileOf, literalSnapshot, snapshotAt } from "./helpers/snapshot.ts";

const data = generateDataset();
const initial: InitialStateFile = initialFileOf(data);

// 2026-09-01 is a Tuesday; the working calendar is Mon-Fri 06:00-18:00 UTC.
const D0 = Date.parse("2026-09-01T00:00:00.000Z");
const at = (day: number, hour: number, min = 0) => D0 + day * 24 * HOUR + hour * HOUR + min * MIN;
const iso = (ms: number) => new Date(ms).toISOString();
const WO = "WO-T";
const WC = initial.master.workCenters?.[0]?.id;

let seq = 0;
const ev = <T extends Parameters<typeof buildEvent>[2]>(ms: number, type: T, payload: Parameters<typeof buildEvent<T>>[3]): FactoryEvent =>
  buildEvent(++seq, iso(ms), type, payload) as FactoryEvent;

function op(id: string, sequence: number, type: "KIT" | "FINAL_TEST" | "REWORK", opts: { rework?: boolean; qty?: number } = {}): ProductionOperation {
  return {
    id,
    productionOrderId: WO,
    sequence,
    type: type as ProductionOperation["type"],
    workstationKind: type === "FINAL_TEST" ? "INSPECTION" : "ASSEMBLY",
    workCenterId: WC,
    quantity: opts.qty ?? 5,
    plannedMinutes: 60,
    isRework: opts.rework ?? false,
    status: "PENDING",
    pausedMinutes: 0,
    interruptedByDowntimeIds: [],
  };
}

const baseOrder = (createdMs: number): ProductionOrder =>
  ({
    id: WO,
    productId: initial.master.products[0].id,
    quantity: 5,
    status: "PLANNED",
    stage: "PLANNING",
    createdAt: iso(createdMs),
    dueDate: iso(createdMs + 10 * 24 * HOUR),
    demandLineIds: [],
    reservations: [],
    materialsConsumed: false,
    operationIds: [],
    inspectionIds: [],
    wipQuantity: 0,
    awaitingQcQuantity: 0,
    reworkPendingQuantity: 0,
    approvedQuantity: 0,
    scrappedQuantity: 0,
    finishedGoodsReceivedQuantity: 0,
  }) as ProductionOrder;

function snap(events: FactoryEvent[], asOfMs: number, order: Partial<ProductionOrder> = {}, downtimes: Downtime[] = []): ReportingSnapshot {
  const first = Date.parse(events[0].timestamp);
  const state = {
    ...initial.state,
    productionOrders: { [WO]: { ...baseOrder(first), ...order } },
    downtimes: Object.fromEntries(downtimes.map((d) => [d.id, d])),
  };
  return literalSnapshot(initial, { asOfMs, events, state, startMs: D0 });
}

const sum = (t: Record<TimeCategory, number>) => TIME_CATEGORIES.reduce((n, c) => n + t[c], 0);
const created = (ms: number, ops: ProductionOperation[]) => ev(ms, "PRODUCTION_ORDER_CREATED", { productionOrder: baseOrder(ms), operations: ops });
const released = (ms: number) => ev(ms, "PRODUCTION_ORDER_RELEASED", { productionOrderId: WO, reservations: [] });
const started = (ms: number, id: string) => ev(ms, "OPERATION_STARTED", { productionOperationId: id, productionOrderId: WO, workstationId: "ASM-001" });
const completedOp = (ms: number, id: string) => ev(ms, "OPERATION_COMPLETED", { productionOperationId: id, productionOrderId: WO, workstationId: "ASM-001" });
const received = (ms: number) => ev(ms, "FINISHED_GOODS_RECEIVED", { productionOrderId: WO, productId: initial.master.products[0].id, quantity: 5, locationId: "FG" });
const inspection = (ms: number, rework: number) =>
  ev(ms, "QUALITY_INSPECTION_COMPLETED", {
    inspection: {
      id: `QI-${ms}`,
      productionOrderId: WO,
      operationId: "T2",
      workstationId: "QC-001",
      round: 1,
      inspectedAt: iso(ms),
      inspectedQuantity: 5,
      passedQuantity: 5 - rework,
      failedQuantity: rework,
      reworkQuantity: rework,
      scrapQuantity: 0,
      defects: [],
    },
  });

describe("WorkOrderTime categories (hand-built histories)", () => {
  it("self-checks the calendar assumption", () => {
    expect(new Date(D0).getUTCDay()).toBe(2);
  });

  it("classifies a straight run and keeps post-operation time out of QUEUE_WAIT", () => {
    seq = 0;
    const events = [
      created(at(0, 8), [op("T1", 10, "KIT"), op("T2", 20, "FINAL_TEST")]),
      released(at(0, 9)),
      started(at(0, 10), "T1"),
      completedOp(at(0, 11), "T1"),
      started(at(0, 17), "T2"),
      completedOp(at(0, 19), "T2"), // runs past 18:00: still PROCESSING
      received(at(0, 20)), // one hour after the last operation
    ];
    const t = workOrderTime(snap(events, at(1, 0), { status: "COMPLETED", releasedAt: iso(at(0, 9)), completedAt: iso(at(0, 20)) }), WO)!;
    expect(t.open).toBe(false);
    expect(t.totalsMs).toMatchObject({
      PRE_RELEASE: 1 * HOUR,
      QUEUE_WAIT: 1 * HOUR + 6 * HOUR,
      PROCESSING: 1 * HOUR + 2 * HOUR,
      POST_PRODUCTION: 1 * HOUR,
      OFF_SHIFT: 0,
      MATERIAL_BLOCKED: 0,
      HELD_MACHINE_DOWN: 0,
      UNCLASSIFIED: 0,
    });
    expect(sum(t.totalsMs)).toBe(t.elapsedMs);
    expect(t.elapsedMs).toBe(12 * HOUR);
    expect(t.tieCount).toBe(0);
    expect(t.flowTimeMs).toBe(12 * HOUR);
    expect(t.cycleTimeMs).toBe(11 * HOUR);
    expect(t.closedQueueWaitMs).toBe(7 * HOUR);
    expect(t.openQueueWaitMs).toBe(0);
  });

  it("splits waiting across the shift boundary into QUEUE_WAIT and OFF_SHIFT", () => {
    seq = 0;
    const events = [
      created(at(0, 8), [op("T1", 10, "KIT"), op("T2", 20, "FINAL_TEST")]),
      released(at(0, 8)),
      started(at(0, 9), "T1"),
      completedOp(at(0, 16), "T1"),
      started(at(1, 7), "T2"), // waited 16:00 -> 07:00 next day
      completedOp(at(1, 8), "T2"),
      received(at(1, 8)),
    ];
    const t = workOrderTime(snap(events, at(2, 0), { status: "COMPLETED", releasedAt: iso(at(0, 8)), completedAt: iso(at(1, 8)) }), WO)!;
    // 16:00-18:00 (2 h) + 06:00-07:00 (1 h) in shift, 18:00-06:00 (12 h) off shift
    expect(t.totalsMs.QUEUE_WAIT).toBe(1 * HOUR /* 08-09 release to start */ + 3 * HOUR);
    expect(t.totalsMs.OFF_SHIFT).toBe(12 * HOUR);
    expect(t.totalsMs.POST_PRODUCTION).toBe(0);
    expect(sum(t.totalsMs)).toBe(t.elapsedMs);
  });

  it("counts a material block as MATERIAL_BLOCKED and the time before it as PRE_RELEASE", () => {
    seq = 0;
    const events = [
      created(at(0, 8), [op("T1", 10, "KIT")]),
      ev(at(0, 9), "PRODUCTION_BLOCKED", { productionOrderId: WO, reason: "MATERIAL_SHORTAGE", shortages: [] }),
      released(at(0, 14)),
      started(at(0, 15), "T1"),
      completedOp(at(0, 16), "T1"),
      received(at(0, 16)),
    ];
    const t = workOrderTime(snap(events, at(2, 0), { status: "COMPLETED", releasedAt: iso(at(0, 14)), completedAt: iso(at(0, 16)) }), WO)!;
    expect(t.totalsMs).toMatchObject({ PRE_RELEASE: 1 * HOUR, MATERIAL_BLOCKED: 5 * HOUR, QUEUE_WAIT: 1 * HOUR, PROCESSING: 1 * HOUR });
    expect(t.conditions.materialShortageMs).toBe(5 * HOUR);
    expect(sum(t.totalsMs)).toBe(t.elapsedMs);
  });

  it("separates a machine-down pause from processing", () => {
    seq = 0;
    const events = [
      created(at(0, 8), [op("T1", 10, "KIT")]),
      released(at(0, 8)),
      started(at(0, 10), "T1"),
      ev(at(0, 11), "PRODUCTION_BLOCKED", { productionOrderId: WO, reason: "MACHINE_DOWN", operationId: "T1", workstationId: "ASM-001", downtimeId: "DT-1" }),
      ev(at(0, 12, 30), "PRODUCTION_RESUMED", { productionOrderId: WO, operationId: "T1", workstationId: "ASM-001", downtimeId: "DT-1" }),
      completedOp(at(0, 14), "T1"),
      received(at(0, 14)),
    ];
    const t = workOrderTime(snap(events, at(1, 0), { status: "COMPLETED", releasedAt: iso(at(0, 8)), completedAt: iso(at(0, 14)) }), WO)!;
    expect(t.totalsMs.HELD_MACHINE_DOWN).toBe(90 * MIN);
    expect(t.totalsMs.PROCESSING).toBe(1 * HOUR + 90 * MIN);
    expect(t.totalsMs.QUEUE_WAIT).toBe(2 * HOUR);
    expect(t.tieCount).toBe(0);
    expect(sum(t.totalsMs)).toBe(t.elapsedMs);
  });

  it("treats a requested rework operation as QUEUE_WAIT, and the gap before the request as UNCLASSIFIED", () => {
    seq = 0;
    const base = [
      created(at(0, 8), [op("T1", 10, "FINAL_TEST")]),
      released(at(0, 8)),
      started(at(0, 9), "T1"),
      inspection(at(0, 10), 2),
      completedOp(at(0, 10), "T1"),
    ];
    const request = (ms: number) =>
      ev(ms, "REWORK_REQUESTED", { productionOrderId: WO, inspectionId: `QI-${at(0, 10)}`, quantity: 2, operations: [op("R1", 20, "REWORK", { rework: true, qty: 2 }), op("R2", 30, "FINAL_TEST", { qty: 2 })] });
    const tail = [started(at(0, 12), "R1"), completedOp(at(0, 13), "R1"), started(at(0, 13), "R2"), completedOp(at(0, 14), "R2"), received(at(0, 14))];

    const same = workOrderTime(snap([...base, request(at(0, 10)), ...tail], at(1, 0), { status: "COMPLETED", releasedAt: iso(at(0, 8)), completedAt: iso(at(0, 14)) }), WO)!;
    expect(same.totalsMs.UNCLASSIFIED).toBe(0);
    expect(same.totalsMs.QUEUE_WAIT).toBe(1 * HOUR + 2 * HOUR); // release->start 1 h, request->rework start 2 h
    expect(sum(same.totalsMs)).toBe(same.elapsedMs);

    seq = 0;
    const gap = workOrderTime(snap([...base.map((e) => e), request(at(0, 10, 30)), ...tail], at(1, 0), { status: "COMPLETED", releasedAt: iso(at(0, 8)), completedAt: iso(at(0, 14)) }), WO)!;
    expect(gap.totalsMs.UNCLASSIFIED).toBe(30 * MIN);
    expect(gap.totalsMs.POST_PRODUCTION).toBe(0);
    expect(sum(gap.totalsMs)).toBe(gap.elapsedMs);
  });

  it("ends an open order at the snapshot time and reports its in-progress wait separately", () => {
    seq = 0;
    const events = [
      created(at(0, 8), [op("T1", 10, "KIT"), op("T2", 20, "FINAL_TEST")]),
      released(at(0, 8)),
      started(at(0, 9), "T1"),
      completedOp(at(0, 10), "T1"),
    ];
    const t = workOrderTime(snap(events, at(0, 15), { status: "RUNNING", releasedAt: iso(at(0, 8)) }), WO)!;
    expect(t.open).toBe(true);
    expect(t.endMs).toBe(at(0, 15));
    expect(t.closedQueueWaitMs).toBe(1 * HOUR);
    expect(t.openQueueWaitMs).toBe(5 * HOUR);
    expect(t.flowTimeMs).toBeNull();
    expect(sum(t.totalsMs)).toBe(t.elapsedMs);
  });

  it("returns null for a cancelled order or one without a creation event", () => {
    seq = 0;
    const events = [created(at(0, 8), [op("T1", 10, "KIT")]), released(at(0, 8))];
    expect(workOrderTime(snap(events, at(0, 12), { status: "CANCELLED" }), WO)).toBeNull();
    expect(workOrderTime(snap([released(at(0, 9))], at(0, 12)), WO)).toBeNull();
  });

  it("measures queue wait overlapping a station outage as a condition, not as a category", () => {
    seq = 0;
    const station = initial.master.workstations.find((w) => w.workCenterIds?.includes(WC!))!;
    const events = [created(at(0, 8), [op("T1", 10, "KIT")]), released(at(0, 8)), started(at(0, 12), "T1"), completedOp(at(0, 13), "T1"), received(at(0, 13))];
    const down: Downtime = { id: "DT-1", workstationId: station.id, failureCode: "X", failedAt: iso(at(0, 9)), expectedRepairMinutes: 60, restoredAt: iso(at(0, 10)) };
    const t = workOrderTime(snap(events, at(1, 0), { status: "COMPLETED", releasedAt: iso(at(0, 8)), completedAt: iso(at(0, 13)) }, [down]), WO)!;
    expect(t.totalsMs.QUEUE_WAIT).toBe(4 * HOUR);
    expect(t.conditions.stationUnavailableMs).toBe(1 * HOUR);
    expect(sum(t.totalsMs)).toBe(t.elapsedMs); // the condition did not change the partition
  });
});

describe("WorkOrderTime on the default dataset", () => {
  const end = endSnapshot(initial, data.events);
  const mid = snapshotAt(initial, data.events, Date.parse(initial.state.asOf) + 12 * 24 * HOUR);

  for (const [label, s] of [["end of run", end], ["mid run (open orders)", mid]] as const) {
    describe(label, () => {
      const ids = Object.keys(s.state.productionOrders).filter((id) => s.state.productionOrders[id].status !== "CANCELLED");

      it("sums every order's categories to its elapsed time exactly, with no unclassified time and no ties", () => {
        let checked = 0;
        for (const id of ids) {
          const t = workOrderTime(s, id);
          expect(t, id).not.toBeNull();
          expect(sum(t!.totalsMs), id).toBe(t!.elapsedMs);
          expect(t!.totalsMs.UNCLASSIFIED, id).toBe(0);
          expect(t!.tieCount, id).toBe(0);
          expect(t!.intervals.every((i) => i.endMs > i.startMs), id).toBe(true);
          checked++;
        }
        expect(checked).toBeGreaterThan(50);
      });

      it("confirms POST_PRODUCTION is zero on simulated data (receipt shares the last operation's timestamp)", () => {
        for (const id of ids) expect(workOrderTime(s, id)!.totalsMs.POST_PRODUCTION, id).toBe(0);
      });

      it("reconciles closed queue wait exactly with the drawer's unrounded step waits, and the displayed values within rounding", () => {
        for (const id of ids) {
          const t = workOrderTime(s, id)!;
          const d = workOrderDetail(s, id)!;
          let readyAt = d.releasedAt ? Date.parse(d.releasedAt) : undefined;
          let exact = 0;
          let shown = 0;
          let steps = 0;
          for (const step of d.routing) {
            if (!step.startedAt) continue;
            const start = Date.parse(step.startedAt);
            if (readyAt !== undefined) {
              exact += shiftMinutesBetween(readyAt, start);
              shown += step.waitMinutes ?? 0;
              steps++;
            }
            if (step.completedAt) readyAt = Date.parse(step.completedAt);
          }
          expect(t.closedQueueWaitMs / MIN, id).toBeCloseTo(exact, 6);
          expect(Math.abs(shown - t.closedQueueWaitMs / MIN), id).toBeLessThanOrEqual(0.5 * steps + 1e-6);
          if (!t.open) expect(t.openQueueWaitMs, id).toBe(0);
        }
      });

      it("keeps the drawer's processing and hold within rounding of PROCESSING and HELD_MACHINE_DOWN for completed steps", () => {
        for (const id of ids) {
          const t = workOrderTime(s, id)!;
          const d = workOrderDetail(s, id)!;
          const done = d.routing.filter((r) => r.completedAt && r.processingMinutes !== undefined);
          if (done.length !== d.routing.filter((r) => r.startedAt).length) continue; // an operation is still running: skip
          const drawer = done.reduce((n, r) => n + (r.processingMinutes ?? 0) + (r.holdMinutes ?? 0), 0);
          const pauses = Object.values(s.state.productionOperations)
            .filter((o) => o.productionOrderId === id)
            .reduce((n, o) => n + o.interruptedByDowntimeIds.length, 0);
          const mine = (t.totalsMs.PROCESSING + t.totalsMs.HELD_MACHINE_DOWN) / MIN;
          expect(Math.abs(drawer - mine), id).toBeLessThanOrEqual(0.5 * (done.length + pauses) + 1e-6);
        }
      });
    });
  }

  it("matches each completed order's flow and cycle time to its timestamps", () => {
    for (const o of Object.values(end.state.productionOrders)) {
      if (o.status !== "COMPLETED") continue;
      const t = workOrderTime(end, o.id)!;
      expect(t.flowTimeMs).toBe(Date.parse(o.completedAt!) - Date.parse(o.createdAt));
      expect(t.cycleTimeMs).toBe(Date.parse(o.completedAt!) - Date.parse(o.releasedAt!));
      expect(t.startMs).toBe(Date.parse(o.createdAt));
    }
  });

  it("reports current-state equipment and backlog only for orders waiting right now", () => {
    let waiting = 0;
    for (const o of Object.values(mid.state.productionOrders)) {
      if (o.status === "COMPLETED" || o.status === "CANCELLED") continue;
      const t = workOrderTime(mid, o.id);
      if (t?.currentWait) {
        waiting++;
        expect(t.currentWait.asOfMs).toBe(mid.asOfMs);
        expect(t.currentWait.queuePosition).toBeGreaterThanOrEqual(1);
        expect(t.currentWait.queuePosition).toBeLessThanOrEqual(t.currentWait.queuedOrders);
      }
    }
    expect(waiting).toBeGreaterThan(0);
    for (const o of Object.values(end.state.productionOrders)) {
      if (o.status === "COMPLETED") expect(workOrderTime(end, o.id)!.currentWait).toBeNull();
    }
  });

  it("is deterministic and does not mutate the snapshot", () => {
    const id = Object.keys(end.state.productionOrders)[5];
    const before = JSON.stringify(end.state.productionOrders[id]);
    expect(workOrderTime(end, id)).toEqual(workOrderTime(end, id));
    expect(JSON.stringify(end.state.productionOrders[id])).toBe(before);
  });
});
