import { beforeAll, describe, expect, it } from "vitest";
import { factoryLayout } from "../src/data/factoryLayout.ts";
import { buildEvent } from "../src/manufacturing/events.ts";
import { generateDataset } from "../src/manufacturing/generator.ts";
import { factoryObjectsForEvent } from "../src/manufacturing/mapping.ts";
import { FactoryReplay, replayEvents } from "../src/manufacturing/replay.ts";
import { InvariantViolation, applyEvent, applyEventInPlace, availableOf, inventoryKey } from "../src/manufacturing/state.ts";
import { validateDataset } from "../src/manufacturing/validation.ts";
import type { EventPayloads, EventType, FactoryEvent, FactoryState, ManufacturingDataset } from "../src/manufacturing/types.ts";

let data: ManufacturingDataset;

beforeAll(() => {
  data = generateDataset();
});

const problems = (name: string) => {
  const report = validateDataset(data);
  const check = report.checks.find((c) => c.name.startsWith(name));
  expect(check, `check "${name}" exists`).toBeDefined();
  return check!.problems;
};

describe("generation", () => {
  it("is deterministic for identical seed and config", () => {
    const again = generateDataset();
    expect(again.manifest.eventLogHash).toBe(data.manifest.eventLogHash);
    expect(JSON.stringify(again.events)).toBe(JSON.stringify(data.events));
    expect(JSON.stringify(again.finalState)).toBe(JSON.stringify(data.finalState));
  });

  it("changes with a different seed", () => {
    const other = generateDataset({ seed: "another-seed" });
    expect(other.manifest.eventLogHash).not.toBe(data.manifest.eventLogHash);
    expect(validateDataset(other).ok).toBe(true);
  });

  it("honours the default dataset shape", () => {
    expect(data.master.products).toHaveLength(3);
    expect(data.master.materials.length).toBeGreaterThanOrEqual(10);
    expect(data.master.materials.length).toBeLessThanOrEqual(15);
    expect(data.master.suppliers).toHaveLength(5);
    expect(data.master.customers).toHaveLength(10);
    expect(data.master.departments).toHaveLength(5);
    expect(data.master.workstations.filter((w) => w.kind === "ASSEMBLY")).toHaveLength(2);
    expect(Object.keys(data.finalState.customerOrders)).toHaveLength(75);
    expect(Object.keys(data.finalState.productionOrders).length).toBeGreaterThan(80);
    expect(Object.keys(data.finalState.productionOrders).length).toBeLessThan(120);
    expect(Object.keys(data.finalState.purchaseOrders).length).toBeGreaterThan(35);
    expect(Object.keys(data.finalState.purchaseOrders).length).toBeLessThan(65);
  });

  it("exercises the interesting scenarios with traceable causes", () => {
    const types = data.manifest.eventTypeCounts;
    for (const t of ["MACHINE_FAILED", "MACHINE_RESTORED", "PRODUCTION_BLOCKED", "REWORK_REQUESTED", "SHIPMENT_DISPATCHED", "MATERIAL_RECEIVED"]) {
      expect(types[t], t).toBeGreaterThan(0);
    }
    const shortage = data.events.find((e) => e.type === "PRODUCTION_BLOCKED" && e.payload.reason === "MATERIAL_SHORTAGE");
    expect(shortage && shortage.type === "PRODUCTION_BLOCKED" && shortage.payload.shortages?.[0].available).toBeLessThan(
      shortage && shortage.type === "PRODUCTION_BLOCKED" ? shortage.payload.shortages![0].required : 0,
    );
    const lateReceipts = Object.values(data.finalState.receipts).filter((r) => r.daysLate > 0);
    expect(lateReceipts.length).toBeGreaterThan(0);
    expect(lateReceipts.every((r) => r.delayReason)).toBe(true);
    const states = new Set(Object.values(data.finalState.customerOrders).map((o) => o.status));
    expect(states.has("SHIPPED")).toBe(true);
    const multiShipped = Object.values(data.finalState.customerOrders).filter(
      (o) => Object.values(data.finalState.shipments).filter((s) => s.customerOrderId === o.id).length > 1,
    );
    expect(multiShipped.length).toBeGreaterThan(0); // partial fulfilment happens
  });

  it("supports other configurations", () => {
    const small = generateDataset({ seed: 7, days: 14, customerOrders: 20, assemblyWorkstations: 1, customerCount: 4, demandSurge: null });
    expect(Object.keys(small.finalState.customerOrders)).toHaveLength(20);
    expect(small.master.customers).toHaveLength(4);
    expect(validateDataset(small).ok).toBe(true);
    expect(() => generateDataset({ days: 2 })).toThrow(/Invalid generator config/);
  });
});

describe("validation of the default dataset", () => {
  it("has no failing checks", () => {
    const report = validateDataset(data);
    expect(report.checks.flatMap((c) => c.problems)).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("has no duplicate IDs", () => expect(problems("no duplicate ids")).toEqual([]));
  it("has referential integrity", () => expect(problems("referential integrity")).toEqual([]));
  it("consumes exactly the BOM requirement", () => expect(problems("BOM")).toEqual([]));
  it("reconciles inventory with transactions", () => expect(problems("inventory reconciles")).toEqual([]));
  it("follows valid production state transitions", () => expect(problems("production state")).toEqual([]));
  it("respects workstation capacity", () => expect(problems("workstation capacity")).toEqual([]));
  it("reconciles finished goods, WIP and QC", () => expect(problems("quality, rework")).toEqual([]));
  it("respects shipment quantity constraints", () => expect(problems("shipment")).toEqual([]));
  it("orders events deterministically", () => expect(problems("event ordering")).toEqual([]));

  it("never lets available inventory go negative at any step", () => {
    const state = structuredClone(data.initialState);
    for (const event of data.events) {
      applyEventInPlace(state, event, data.master);
      for (const b of Object.values(state.inventory)) {
        expect(availableOf(b), `${event.id} ${inventoryKey(b.locationId, b.itemId)}`).toBeGreaterThanOrEqual(0);
        expect(b.onHand).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("only creates finished goods from completed, QC-approved production", () => {
    const receipts = data.finalState.inventoryTransactions.filter((t) => t.type === "FG_RECEIPT");
    expect(receipts.length).toBeGreaterThan(0);
    for (const t of receipts) {
      const order = data.finalState.productionOrders[t.referenceId];
      expect(order.status).toBe("COMPLETED");
      expect(order.approvedQuantity).toBeGreaterThanOrEqual(t.onHandDelta);
      expect(order.inspectionIds.length).toBeGreaterThan(0);
    }
  });

  it("detects a corrupted dataset", () => {
    const bad = structuredClone(data);
    const key = Object.keys(bad.finalState.inventory)[0];
    bad.finalState.inventory[key].onHand += 5;
    expect(validateDataset(bad).ok).toBe(false);
  });
});

describe("event log and replay", () => {
  it("has strictly increasing sequence numbers and non-decreasing time", () => {
    data.events.forEach((e, i) => expect(e.sequence).toBe(i + 1));
    for (let i = 1; i < data.events.length; i++) {
      expect(Date.parse(data.events[i].timestamp)).toBeGreaterThanOrEqual(Date.parse(data.events[i - 1].timestamp));
    }
  });

  it("reconstructs the final state from initial state + events (including via JSON)", () => {
    const replayed = replayEvents(data.master, data.initialState, data.events);
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(data.finalState));

    const viaJson = replayEvents(
      JSON.parse(JSON.stringify(data.master)),
      JSON.parse(JSON.stringify(data.initialState)),
      JSON.parse(JSON.stringify(data.events)),
    );
    expect(JSON.stringify(viaJson)).toBe(JSON.stringify(data.finalState));
  });

  it("does not mutate the initial state or the event payloads", () => {
    const before = JSON.stringify(data.initialState);
    replayEvents(data.master, data.initialState, data.events);
    expect(JSON.stringify(data.initialState)).toBe(before);
  });

  it("supports a simulated clock with seeking", () => {
    const replay = new FactoryReplay({ schemaVersion: "1", master: data.master, state: data.initialState }, data.events);
    const mid = data.events[Math.floor(data.events.length / 2)].timestamp;
    const seen: string[] = [];
    replay.onEvent((e) => seen.push(e.id));
    const applied = replay.advanceTo(mid);
    expect(seen).toHaveLength(applied.length);
    expect(replay.state.asOf <= mid).toBe(true);
    replay.seekTo(data.initialState.asOf);
    expect(replay.position).toBe(0);
    replay.advanceTo(data.manifest.simulatedRange.end);
    expect(JSON.stringify(replay.state)).toBe(JSON.stringify(data.finalState));
  });

  it("maps events to existing 3D factory object ids", () => {
    const layoutIds = new Set(factoryLayout.map((o) => o.id));
    let mapped = 0;
    for (const e of data.events) {
      const { objectIds, flows } = factoryObjectsForEvent(e);
      for (const id of objectIds) expect(layoutIds.has(id), `${e.id} -> ${id}`).toBe(true);
      for (const f of flows) {
        for (const id of [f.from, f.to]) expect(id === "EXTERNAL" || layoutIds.has(id)).toBe(true);
      }
      if (objectIds.length > 0) mapped++;
    }
    expect(mapped).toBeGreaterThan(data.events.length / 2);
    for (const l of data.master.locations) expect(layoutIds.has(l.id)).toBe(true);
  });
});

describe("invalid operations are rejected", () => {
  /** State right after the first production order is created (nothing reserved yet). */
  function stateWithPlannedOrder() {
    const state = structuredClone(data.initialState);
    for (const e of data.events) {
      applyEventInPlace(state, e, data.master);
      if (e.type === "PRODUCTION_ORDER_CREATED") return { state, orderId: e.payload.productionOrder.id };
    }
    throw new Error("no production order in dataset");
  }

  const next = <T extends EventType>(state: FactoryState, type: T, payload: EventPayloads[T]) =>
    buildEvent(state.lastSequence + 1, state.asOf, type, payload) as unknown as FactoryEvent;

  it("rejects consuming material that was never reserved", () => {
    const { state, orderId } = stateWithPlannedOrder();
    const order = state.productionOrders[orderId];
    const bom = data.master.billsOfMaterials.find((b) => b.productId === order.productId)!;
    const event = next(state, "MATERIAL_CONSUMED", {
      productionOrderId: orderId,
      consumptions: bom.lines.map((l) => ({
        materialId: l.materialId,
        quantity: l.quantityPer * order.quantity,
        fromLocationId: data.master.materials.find((m) => m.id === l.materialId)!.storageLocationId,
        toLocationId: "ASM-001",
      })),
    });
    const snapshot = JSON.stringify(state);
    expect(() => applyEvent(state, event, data.master)).toThrow(InvariantViolation);
    expect(JSON.stringify(state)).toBe(snapshot); // pure wrapper left the input untouched
  });

  it("rejects consumption that exceeds the reservation / BOM", () => {
    const { state, orderId } = stateWithPlannedOrder();
    const order = state.productionOrders[orderId];
    const bom = data.master.billsOfMaterials.find((b) => b.productId === order.productId)!;
    const reservations = bom.lines.map((l) => ({
      materialId: l.materialId,
      quantity: l.quantityPer * order.quantity,
      locationId: data.master.materials.find((m) => m.id === l.materialId)!.storageLocationId,
    }));
    const released = applyEvent(state, next(state, "PRODUCTION_ORDER_RELEASED", { productionOrderId: orderId, reservations }), data.master);
    const tooMuch = next(released, "MATERIAL_CONSUMED", {
      productionOrderId: orderId,
      consumptions: reservations.map((r, i) => ({
        materialId: r.materialId,
        quantity: r.quantity + (i === 0 ? 1 : 0),
        fromLocationId: r.locationId,
        toLocationId: "ASM-001",
      })),
    });
    expect(() => applyEvent(released, tooMuch, data.master)).toThrow(/BOM requirement/);
  });

  it("rejects reserving or transferring more than is available", () => {
    const { state, orderId } = stateWithPlannedOrder();
    const order = state.productionOrders[orderId];
    const bom = data.master.billsOfMaterials.find((b) => b.productId === order.productId)!;
    const first = bom.lines[0];
    const loc = data.master.materials.find((m) => m.id === first.materialId)!.storageLocationId;
    // Drain the shelf by transferring everything away, then try to reserve.
    const onHand = state.inventory[inventoryKey(loc, first.materialId)].onHand;
    const drained = applyEvent(
      state,
      next(state, "INVENTORY_TRANSFERRED", {
        transfer: { id: "TRF-X", itemId: first.materialId, itemKind: "RAW_MATERIAL", quantity: onHand, fromLocationId: loc, toLocationId: "REC-001", reason: "PUTAWAY" },
      }),
      data.master,
    );
    const reserve = next(drained, "PRODUCTION_ORDER_RELEASED", {
      productionOrderId: orderId,
      reservations: bom.lines.map((l) => ({
        materialId: l.materialId,
        quantity: l.quantityPer * order.quantity,
        locationId: data.master.materials.find((m) => m.id === l.materialId)!.storageLocationId,
      })),
    });
    expect(() => applyEvent(drained, reserve, data.master)).toThrow(/available/);

    const overTransfer = next(state, "INVENTORY_TRANSFERRED", {
      transfer: { id: "TRF-Y", itemId: first.materialId, itemKind: "RAW_MATERIAL", quantity: onHand + 1, fromLocationId: loc, toLocationId: "REC-001", reason: "PUTAWAY" },
    });
    expect(() => applyEvent(state, overTransfer, data.master)).toThrow(InvariantViolation);
  });

  it("rejects duplicate and out-of-order event processing", () => {
    const state = structuredClone(data.initialState);
    const first = data.events[0];
    const once = applyEvent(state, first, data.master);
    expect(() => applyEvent(once, first, data.master)).toThrow(/expected sequence/);
    expect(() => applyEvent(state, data.events[2], data.master)).toThrow(/expected sequence/);
  });

  it("rejects starting production before materials are consumed and shipping more than allocated", () => {
    const { state, orderId } = stateWithPlannedOrder();
    const start = next(state, "PRODUCTION_STARTED", { productionOrderId: orderId, workstationId: "ASM-001", assignmentId: "ASG-X" });
    expect(() => applyEvent(state, start, data.master)).toThrow(InvariantViolation);

    // Find a state where a customer order exists, then ship without allocation.
    const s2 = structuredClone(data.initialState);
    let order;
    for (const e of data.events) {
      applyEventInPlace(s2, e, data.master);
      if (e.type === "CUSTOMER_ORDER_CREATED") { order = e.payload.customerOrder; break; }
    }
    const line = s2.customerOrders[order!.id].lines[0];
    const ship = next(s2, "SHIPMENT_DISPATCHED", {
      shipment: {
        id: "SHIP-X", customerOrderId: order!.id, customerId: order!.customerId, dispatchedAt: s2.asOf, carrier: "x",
        lines: [{ id: "SHIP-X-L1", customerOrderLineId: line.id, productId: line.productId, quantity: line.quantity,
          fromLocationId: data.master.products.find((p) => p.id === line.productId)!.finishedGoodsLocationId }],
      },
    });
    expect(() => applyEvent(s2, ship, data.master)).toThrow(/exceeds/);
  });

  it("rejects finished goods that were not QC-approved", () => {
    const { state, orderId } = stateWithPlannedOrder();
    const order = state.productionOrders[orderId];
    const receive = next(state, "FINISHED_GOODS_RECEIVED", {
      productionOrderId: orderId,
      productId: order.productId,
      quantity: order.quantity,
      locationId: data.master.products.find((p) => p.id === order.productId)!.finishedGoodsLocationId,
    });
    expect(() => applyEvent(state, receive, data.master)).toThrow(InvariantViolation);
  });
});
