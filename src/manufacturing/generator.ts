/**
 * Deterministic synthetic history generator.
 *
 * A small discrete-event simulation drives the factory forward in time. It never
 * writes records directly: every change is *proposed as an event* and applied
 * through the same reducer used for replay (state.ts), so the generated history
 * is valid by construction and every effect has a recorded cause:
 *
 *  - supplier delay      -> late MATERIAL_RECEIVED -> PRODUCTION_BLOCKED (MATERIAL_SHORTAGE,
 *                           listing the open PO that will cover it) -> later release
 *  - machine failure     -> MACHINE_FAILED -> running operation paused -> PRODUCTION_BLOCKED
 *                           (MACHINE_DOWN) -> MACHINE_RESTORED -> PRODUCTION_RESUMED;
 *                           interrupted orders have a higher defect rate, and failed
 *                           inspections point back at the downtime id
 *  - demand surge        -> orders with demandDriver SURGE_CAMPAIGN -> queue growth at
 *                           assembly (bottleneck) and purchase-forecast misses
 *  - quality failure     -> REWORK_REQUESTED -> rework + retest, or scrap
 *
 * Calendar: assembly/QC start new work Mon-Fri 06:00-18:00 UTC; started operations
 * run to completion. Purchasing reviews and dispatch run on working days.
 */

import { DAY, HOUR, MIN, SHIFT_END_HOUR, SHIFT_START_HOUR, dayStart, inShift, isWorkingDay, rollToWorkingDay } from "./calendar.ts";
import { buildEvent } from "./events.ts";
import { PRODUCT_MIX, REWORK_MINUTES_PER_UNIT, REWORK_SETUP_MINUTES, buildMasterData, resolveConfig } from "./masterData.ts";
import { Rng } from "./rng.ts";
import { applyEventInPlace, availableAt, createEmptyState, indexMaster, setOpeningBalance } from "./state.ts";
import { SCHEMA_VERSION } from "./types.ts";
import type {
  CustomerOrder,
  DefectCode,
  DefectCount,
  DelayReason,
  EventPayloads,
  EventType,
  FactoryEvent,
  FactoryState,
  GeneratorConfig,
  Id,
  Manifest,
  ManufacturingDataset,
  MasterData,
  OperationType,
  ProductionOperation,
  ProductionOrder,
  PurchaseOrder,
} from "./types.ts";

/** Expected units per customer order (1.35 lines x 3.5 units) used for cover planning. */
const AVG_UNITS_PER_ORDER = 4.7;
const FAILURE_CODES = ["SERVO_FAULT", "CONVEYOR_JAM", "TORQUE_TOOL_FAILURE", "POWER_SUPPLY_TRIP"];
const DELAY_REASONS: DelayReason[] = ["CARRIER_DELAY", "SUPPLIER_STOCKOUT", "CUSTOMS_HOLD"];
const CARRIERS = ["Redline Freight", "Pinecrest Logistics", "Summit Parcel Co."];
const ASSEMBLY_TYPES: OperationType[] = ["MOUNT_AND_WIRE", "MOTOR_CIRCUIT_ASSEMBLY", "PLC_HMI_INTEGRATION", "KIT", "MOUNT", "WIRE", "CONFIGURE"];

const iso = (ms: number) => new Date(ms).toISOString();
const roundUp = (value: number, multiple: number) => Math.ceil(value / multiple) * multiple;

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

function expectedDailyUsage(config: GeneratorConfig, master: MasterData): Map<Id, number> {
  const unitsPerDay = (config.customerOrders * AVG_UNITS_PER_ORDER) / config.days;
  const usage = new Map<Id, number>();
  for (const bom of master.billsOfMaterials) {
    const share = PRODUCT_MIX[bom.productId] ?? 0;
    for (const line of bom.lines) {
      usage.set(line.materialId, (usage.get(line.materialId) ?? 0) + unitsPerDay * share * line.quantityPer);
    }
  }
  return usage;
}

export function buildInitialState(config: GeneratorConfig, master: MasterData): FactoryState {
  const state = createEmptyState(config.startDate, master);
  const usage = expectedDailyUsage(config, master);
  for (const mat of master.materials) {
    const qty = roundUp((usage.get(mat.id) ?? 0) * mat.initialCoverDays, mat.orderMultiple);
    setOpeningBalance(state, mat.storageLocationId, mat.id, "RAW_MATERIAL", qty);
  }
  for (const product of master.products) {
    setOpeningBalance(state, product.finishedGoodsLocationId, product.id, "FINISHED_GOOD", config.openingFinishedGoodsUnits);
  }
  return state;
}

// ---------------------------------------------------------------------------
// Priority queue
// ---------------------------------------------------------------------------

interface Action {
  time: number;
  order: number;
  run: () => void;
}

class ActionQueue {
  private heap: Action[] = [];
  private counter = 0;

  push(time: number, run: () => void): void {
    const action = { time, order: this.counter++, run };
    const h = this.heap;
    h.push(action);
    let i = h.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.less(h[parent], h[i])) break;
      [h[parent], h[i]] = [h[i], h[parent]];
      i = parent;
    }
  }

  peekTime(): number | undefined {
    return this.heap[0]?.time;
  }

  pop(): Action | undefined {
    const h = this.heap;
    if (h.length === 0) return undefined;
    const top = h[0];
    const last = h.pop()!;
    if (h.length > 0) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let s = i;
        if (l < h.length && this.less(h[l], h[s])) s = l;
        if (r < h.length && this.less(h[r], h[s])) s = r;
        if (s === i) break;
        [h[s], h[i]] = [h[i], h[s]];
        i = s;
      }
    }
    return top;
  }

  private less(a: Action, b: Action): boolean {
    return a.time < b.time || (a.time === b.time && a.order < b.order);
  }
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

interface PlannedDemand {
  atMs: number;
  customerId: Id;
  driver: "BASELINE" | "SURGE_CAMPAIGN";
  lines: Array<{ productId: Id; quantity: number }>;
  dueInDays: number;
  cancelAfterDays?: number;
}

class Simulation {
  readonly events: FactoryEvent[] = [];
  private readonly queue = new ActionQueue();
  private readonly counters = new Map<string, number>();
  private readonly idx: ReturnType<typeof indexMaster>;
  private readonly config: GeneratorConfig;
  private readonly master: MasterData;
  readonly state: FactoryState;
  private readonly startMs: number;
  private readonly endMs: number;
  private readonly supplierRng: Rng;
  private readonly qualityRng: Rng;
  private readonly opsRng: Rng;
  private readonly demandRng: Rng;
  private readonly failureRng: Rng;
  private readonly opRuntime = new Map<Id, { endsAt: number; token: number; remainingMs?: number }>();
  private tokenCounter = 0;
  private readonly usage: Map<Id, number>;
  private readonly reviewCycleDays: number;

  constructor(config: GeneratorConfig, master: MasterData, state: FactoryState) {
    this.config = config;
    this.master = master;
    this.state = state;
    const root = new Rng(config.seed);
    this.supplierRng = root.fork("suppliers");
    this.qualityRng = root.fork("quality");
    this.opsRng = root.fork("operations");
    this.demandRng = root.fork("demand");
    this.failureRng = root.fork("failures");
    this.idx = indexMaster(master);
    this.startMs = Date.parse(config.startDate);
    this.endMs = this.startMs + config.days * DAY;
    this.usage = expectedDailyUsage(config, master);

    let workingDays = 0;
    for (let d = 0; d < config.days; d++) if (isWorkingDay(this.startMs + d * DAY)) workingDays++;
    this.reviewCycleDays = Math.max(1, Math.round((master.suppliers.length * workingDays) / config.purchaseOrders));
  }

  // ----- plumbing -----------------------------------------------------------

  private nextId(prefix: string, width = 4): Id {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}-${String(n).padStart(width, "0")}`;
  }

  private emit<T extends EventType>(type: T, ms: number, payload: EventPayloads[T]): FactoryEvent<T> {
    const event = buildEvent(this.state.lastSequence + 1, iso(ms), type, payload);
    applyEventInPlace(this.state, event as FactoryEvent, this.master);
    this.events.push(event as FactoryEvent);
    return event;
  }

  private at(ms: number, run: () => void) {
    if (ms <= this.endMs) this.queue.push(ms, run);
  }

  run(): FactoryEvent[] {
    this.scheduleDemand();
    this.scheduleFailures();
    this.scheduleDailyJobs();
    for (;;) {
      const t = this.queue.peekTime();
      if (t === undefined || t > this.endMs) break;
      this.queue.pop()!.run();
    }
    return this.events;
  }

  // ----- scheduling of exogenous things ------------------------------------

  private scheduleDailyJobs() {
    for (let d = 0; d <= this.config.days; d++) {
      const day = this.startMs + d * DAY;
      if (!isWorkingDay(day)) continue;
      const dayIndex = d;
      this.at(day + 6 * HOUR, () => {
        this.purchasingReview(day + 6 * HOUR, dayIndex);
        this.dispatch(day + 6 * HOUR);
      });
      this.at(day + 15 * HOUR, () => this.shipOrders(day + 15 * HOUR));
    }
  }

  private scheduleDemand() {
    const { days, customerOrders, demandSurge } = this.config;
    const dayIndexes: number[] = [];
    const weights: number[] = [];
    for (let d = 0; d < days - 1; d++) {
      if (!isWorkingDay(this.startMs + d * DAY)) continue;
      dayIndexes.push(d);
      const inSurge = demandSurge && d >= demandSurge.startDay && d <= demandSurge.endDay;
      weights.push(inSurge ? demandSurge.multiplier : 1);
    }
    const products = this.master.products.map((p) => p.id);
    const mix = products.map((p) => PRODUCT_MIX[p] ?? 1);
    const customers = this.master.customers.map((c) => c.id);
    const campaignCustomers = ["CUS-002", "CUS-010"].filter((c) => customers.includes(c));
    const plans: PlannedDemand[] = [];

    for (let i = 0; i < customerOrders; i++) {
      const d = this.demandRng.weighted(dayIndexes, weights);
      const atMs = this.startMs + d * DAY + this.demandRng.int(8 * 60, 16 * 60 + 59) * MIN;
      const inSurge = !!demandSurge && d >= demandSurge.startDay && d <= demandSurge.endDay;
      const campaign = inSurge && campaignCustomers.length > 0 && this.demandRng.chance(0.7);
      let plan: PlannedDemand;
      if (campaign) {
        plan = {
          atMs,
          customerId: this.demandRng.pick(campaignCustomers),
          driver: "SURGE_CAMPAIGN",
          lines: [{ productId: "NCP-200", quantity: this.demandRng.int(4, 10) }],
          dueInDays: this.demandRng.int(10, 16),
        };
      } else {
        const lineCount = this.demandRng.chance(0.35) ? 2 : 1;
        const chosen: Id[] = [];
        while (chosen.length < lineCount) {
          const p = this.demandRng.weighted(products, mix);
          if (!chosen.includes(p)) chosen.push(p);
        }
        plan = {
          atMs,
          customerId: this.demandRng.pick(customers),
          driver: "BASELINE",
          lines: chosen.map((productId) => ({ productId, quantity: this.demandRng.int(1, 6) })),
          dueInDays: this.demandRng.int(7, 14),
        };
      }
      if (this.demandRng.chance(0.04)) plan.cancelAfterDays = this.demandRng.int(1, 3);
      plans.push(plan);
    }

    plans.sort((a, b) => a.atMs - b.atMs);
    for (const plan of plans) {
      const orderId = this.nextId("CO");
      this.at(plan.atMs, () => this.createCustomerOrder(orderId, plan));
    }
  }

  private scheduleFailures() {
    const { days, machineFailuresPerWorkstation } = this.config;
    for (const ws of this.master.workstations.filter((w) => w.kind === "ASSEMBLY")) {
      const chosenDays = new Set<number>();
      let guard = 0;
      while (chosenDays.size < machineFailuresPerWorkstation && guard++ < 200) {
        const d = this.failureRng.int(2, Math.max(2, days - 4));
        if (isWorkingDay(this.startMs + d * DAY) && ![...chosenDays].some((x) => Math.abs(x - d) < 2)) chosenDays.add(d);
      }
      for (const d of [...chosenDays].sort((a, b) => a - b)) {
        const failAt = this.startMs + d * DAY + this.failureRng.int(SHIFT_START_HOUR * 60 + 30, SHIFT_END_HOUR * 60 - 60) * MIN;
        const repair = this.failureRng.int(60, 300);
        const code = this.failureRng.pick(FAILURE_CODES);
        this.at(failAt, () => this.machineFails(ws.id, failAt, repair, code));
      }
    }
  }

  // ----- customer orders, allocation, planning -----------------------------

  private createCustomerOrder(id: Id, plan: PlannedDemand) {
    const now = plan.atMs;
    const order: CustomerOrder = {
      id,
      customerId: plan.customerId,
      createdAt: iso(now),
      dueDate: iso(rollToWorkingDay(dayStart(now) + plan.dueInDays * DAY + 17 * HOUR)),
      status: "OPEN",
      demandDriver: plan.driver,
      lines: plan.lines.map((l, i) => {
        const product = this.idx.products.get(l.productId)!;
        return {
          id: `${id}-L${i + 1}`,
          lineNumber: i + 1,
          productId: l.productId,
          quantity: l.quantity,
          allocatedQuantity: 0,
          shippedQuantity: 0,
          unitPriceCents: Math.round(product.listPriceCents * (l.quantity >= 5 ? 0.95 : 1)),
        };
      }),
    };
    this.emit("CUSTOMER_ORDER_CREATED", now, { customerOrder: order });
    if (plan.cancelAfterDays !== undefined) {
      const cancelAt = rollToWorkingDay(dayStart(now) + plan.cancelAfterDays * DAY + 9 * HOUR);
      this.at(cancelAt, () => this.cancelCustomerOrder(id, cancelAt));
    }
    this.allocateFinishedGoods(now);
    this.planProduction(now);
    this.dispatch(now);
  }

  private cancelCustomerOrder(id: Id, now: number) {
    const order = this.state.customerOrders[id];
    if (order.status !== "OPEN" || order.lines.some((l) => l.shippedQuantity > 0)) return;
    this.emit("CUSTOMER_ORDER_CANCELLED", now, { customerOrderId: id, reason: "CUSTOMER_REQUEST" });
    this.allocateFinishedGoods(now);
    this.trimSurplusProduction(now);
    this.retryBlocked(now);
    this.dispatch(now);
  }

  private openOrders(): CustomerOrder[] {
    return Object.values(this.state.customerOrders)
      .filter((o) => o.status === "OPEN" || o.status === "PARTIALLY_SHIPPED")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  private allocateFinishedGoods(now: number) {
    for (const product of this.master.products) {
      let available = availableAt(this.state, product.finishedGoodsLocationId, product.id);
      if (available <= 0) continue;
      for (const order of this.openOrders()) {
        for (const line of order.lines) {
          if (line.productId !== product.id || available <= 0) continue;
          const need = line.quantity - line.allocatedQuantity - line.shippedQuantity;
          const qty = Math.min(need, available);
          if (qty <= 0) continue;
          this.emit("FINISHED_GOODS_ALLOCATED", now, {
            allocationId: this.nextId("ALC"),
            customerOrderId: order.id,
            customerOrderLineId: line.id,
            productId: product.id,
            quantity: qty,
            locationId: product.finishedGoodsLocationId,
          });
          available -= qty;
        }
      }
    }
  }

  /** Unallocated customer demand and in-flight supply for one product. */
  private position(productId: Id) {
    let demand = 0;
    const lines: Array<{ id: Id; due: string }> = [];
    for (const order of this.openOrders()) {
      for (const line of order.lines) {
        if (line.productId !== productId) continue;
        const need = line.quantity - line.allocatedQuantity - line.shippedQuantity;
        if (need > 0) {
          demand += need;
          lines.push({ id: line.id, due: order.dueDate });
        }
      }
    }
    let supply = 0;
    for (const po of Object.values(this.state.productionOrders)) {
      if (po.productId !== productId || po.status === "COMPLETED" || po.status === "CANCELLED") continue;
      supply += po.quantity - po.scrappedQuantity - po.finishedGoodsReceivedQuantity;
    }
    const product = this.idx.products.get(productId)!;
    const onShelf = availableAt(this.state, product.finishedGoodsLocationId, productId);
    return { demand, supply, onShelf, lines };
  }

  private planProduction(now: number) {
    for (const product of this.master.products) {
      const { demand, supply, onShelf, lines } = this.position(product.id);
      const shortfall = demand - supply - onShelf;
      if (shortfall <= 0) continue;
      const yieldAllowance = shortfall >= 6 ? Math.ceil(shortfall * 0.05) : 0;
      const quantity = Math.max(this.config.minProductionLot, shortfall + yieldAllowance);
      const order = this.createProductionOrder(product.id, quantity, lines, now);
      this.tryRelease(order, now);
    }
  }

  private createProductionOrder(productId: Id, quantity: number, lines: Array<{ id: Id; due: string }>, now: number): ProductionOrder {
    const id = this.nextId("WO");
    const routing = this.idx.routingByProduct.get(productId)!;
    const operations: ProductionOperation[] = routing.steps.map((step) => ({
      id: `OP-${id}-${step.sequence}`,
      productionOrderId: id,
      sequence: step.sequence,
      type: step.operationType,
      workstationKind: step.workstationKind,
      ...(step.workCenterId ? { workCenterId: step.workCenterId } : {}),
      quantity,
      plannedMinutes: step.setupMinutes + step.minutesPerUnit * quantity,
      isRework: false,
      status: "PENDING",
      pausedMinutes: 0,
      interruptedByDowntimeIds: [],
    }));
    const dueDate = lines.map((l) => l.due).sort()[0] ?? iso(now + 7 * DAY);
    const order: ProductionOrder = {
      id,
      productId,
      quantity,
      status: "PLANNED",
      stage: "PLANNING",
      createdAt: iso(now),
      dueDate,
      demandLineIds: lines.map((l) => l.id),
      reservations: [],
      materialsConsumed: false,
      operationIds: operations.map((o) => o.id),
      inspectionIds: [],
      wipQuantity: 0,
      awaitingQcQuantity: 0,
      reworkPendingQuantity: 0,
      approvedQuantity: 0,
      scrappedQuantity: 0,
      finishedGoodsReceivedQuantity: 0,
    };
    this.emit("PRODUCTION_ORDER_CREATED", now, { productionOrder: order, operations });
    return this.state.productionOrders[id];
  }

  private rawAvailable(materialId: Id): number {
    return Object.values(this.state.inventory)
      .filter((b) => b.itemId === materialId && this.idx.locations.get(b.locationId)!.kind === "RAW_STORAGE")
      .reduce((s, b) => s + (b.onHand - b.reserved), 0);
  }

  /** Reserve materials if every BOM line is available; otherwise block with a traceable shortage. */
  private tryRelease(order: ProductionOrder, now: number): boolean {
    const bom = this.idx.bomByProduct.get(order.productId)!;
    const shortages = [];
    for (const line of bom.lines) {
      const required = line.quantityPer * order.quantity;
      const available = this.rawAvailable(line.materialId);
      if (available < required) {
        const expected = Object.values(this.state.purchaseOrders)
          .filter((po) => po.status !== "RECEIVED" && po.lines.some((l) => l.materialId === line.materialId && l.receivedQuantity < l.orderedQuantity))
          .map((po) => po.id);
        shortages.push({ materialId: line.materialId, required, available, expectedPurchaseOrderIds: expected });
      }
    }
    if (shortages.length === 0) {
      this.emit("PRODUCTION_ORDER_RELEASED", now, {
        productionOrderId: order.id,
        reservations: bom.lines.map((l) => ({
          materialId: l.materialId,
          quantity: l.quantityPer * order.quantity,
          locationId: this.idx.materials.get(l.materialId)!.storageLocationId,
        })),
      });
      return true;
    }
    if (order.status === "PLANNED") {
      this.emit("PRODUCTION_BLOCKED", now, { productionOrderId: order.id, reason: "MATERIAL_SHORTAGE", shortages });
    }
    return false;
  }

  private retryBlocked(now: number) {
    const waiting = Object.values(this.state.productionOrders)
      .filter((o) => o.status === "PLANNED" || (o.status === "BLOCKED" && o.blockReason === "MATERIAL_SHORTAGE"))
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id));
    for (const order of waiting) this.tryRelease(order, now);
  }

  private trimSurplusProduction(now: number) {
    for (const product of this.master.products) {
      const { demand, supply, onShelf } = this.position(product.id);
      let surplus = supply + onShelf - demand;
      if (surplus <= 0) continue;
      const cancellable = Object.values(this.state.productionOrders)
        .filter((o) => o.productId === product.id && !o.startedAt && ["PLANNED", "WAITING", "BLOCKED"].includes(o.status))
        .sort((a, b) => b.id.localeCompare(a.id));
      for (const order of cancellable) {
        if (order.quantity > surplus) continue;
        this.emit("PRODUCTION_ORDER_CANCELLED", now, { productionOrderId: order.id, reason: "DEMAND_CANCELLED" });
        surplus -= order.quantity;
      }
    }
  }

  // ----- purchasing & receiving --------------------------------------------

  private purchasingReview(now: number, dayIndex: number) {
    const cycle = this.reviewCycleDays;
    this.master.suppliers.forEach((supplier, i) => {
      if ((dayIndex + i) % cycle !== 0) return;
      const lines: PurchaseOrder["lines"] = [];
      for (const mat of this.master.materials.filter((m) => m.supplierId === supplier.id)) {
        const daily = this.usage.get(mat.id) ?? 0;
        let position = this.rawAvailable(mat.id);
        for (const po of Object.values(this.state.purchaseOrders)) {
          for (const l of po.lines) if (l.materialId === mat.id) position += l.orderedQuantity - l.receivedQuantity;
        }
        // Requirement of orders that are known but not yet reserved.
        for (const wo of Object.values(this.state.productionOrders)) {
          if (wo.status !== "PLANNED" && !(wo.status === "BLOCKED" && !wo.releasedAt)) continue;
          const bomLine = this.idx.bomByProduct.get(wo.productId)!.lines.find((l) => l.materialId === mat.id);
          if (bomLine) position -= bomLine.quantityPer * wo.quantity;
        }
        const target = daily * (mat.leadTimeDays + cycle + mat.safetyDays);
        const trigger = target - 0.5 * cycle * daily;
        if (position >= trigger) continue;
        const quantity = roundUp(target - position, mat.orderMultiple);
        const variance = 1 + (this.supplierRng.int(-3, 3) / 100);
        lines.push({
          id: "",
          lineNumber: lines.length + 1,
          materialId: mat.id,
          orderedQuantity: quantity,
          receivedQuantity: 0,
          unitCostCents: Math.round(mat.standardCostCents * variance),
        });
      }
      if (lines.length > 0) this.createPurchaseOrder(supplier.id, lines, now);
    });
  }

  private createPurchaseOrder(supplierId: Id, lines: PurchaseOrder["lines"], now: number) {
    const supplier = this.idx.suppliers.get(supplierId)!;
    const id = this.nextId("PO");
    const promisedMs = rollToWorkingDay(dayStart(now) + supplier.leadTimeDays * DAY) + 10 * HOUR;
    for (const l of lines) l.id = `POL-${id.slice(3)}-${l.lineNumber}`;
    const po: PurchaseOrder = {
      id,
      supplierId,
      createdAt: iso(now),
      promisedDeliveryAt: iso(promisedMs),
      receivingLocationId: supplier.receivingLocationId,
      status: "OPEN",
      reason: "REORDER_POINT",
      lines,
      totalCents: lines.reduce((s, l) => s + l.orderedQuantity * l.unitCostCents, 0),
    };
    this.emit("PURCHASE_ORDER_CREATED", now, { purchaseOrder: po });

    // The supplier's real behaviour is drawn now but only becomes visible when
    // the receipt events happen; the planner above never sees it.
    const delayed = !this.supplierRng.chance(supplier.onTimeRate);
    const delayDays = delayed ? this.supplierRng.int(1, 5) : 0;
    const reason: DelayReason | undefined = delayed ? this.supplierRng.pick(DELAY_REASONS) : undefined;
    const arrival = rollToWorkingDay(dayStart(promisedMs) + delayDays * DAY) + this.supplierRng.int(7, 15) * HOUR;
    const split = delayed && this.supplierRng.chance(0.4);

    const firstLines = lines.map((l) => ({
      line: l,
      quantity: split ? Math.max(1, Math.floor(l.orderedQuantity * 0.6)) : l.orderedQuantity,
    }));
    this.at(arrival, () => this.receive(po, firstLines, arrival, promisedMs, reason, split));

    if (split) {
      const restAt = rollToWorkingDay(arrival + this.supplierRng.int(2, 4) * DAY);
      const restLines = lines
        .map((l, i) => ({ line: l, quantity: l.orderedQuantity - firstLines[i].quantity }))
        .filter((x) => x.quantity > 0);
      if (restLines.length > 0) {
        this.at(restAt, () => this.receive(po, restLines, restAt, promisedMs, "SUPPLIER_STOCKOUT", false));
      }
    }
  }

  private receive(
    po: PurchaseOrder,
    lines: Array<{ line: PurchaseOrder["lines"][number]; quantity: number }>,
    now: number,
    promisedMs: number,
    reason: DelayReason | undefined,
    shortShipment: boolean,
  ) {
    const daysLate = Math.max(0, Math.floor((dayStart(now) - dayStart(promisedMs)) / DAY));
    const receiptId = this.nextId("RCV");
    this.emit("MATERIAL_RECEIVED", now, {
      receipt: {
        id: receiptId,
        purchaseOrderId: po.id,
        supplierId: po.supplierId,
        receivedAt: iso(now),
        locationId: po.receivingLocationId,
        lines: lines.map((l, i) => ({
          id: `${receiptId}-L${i + 1}`,
          purchaseOrderLineId: l.line.id,
          materialId: l.line.materialId,
          quantity: l.quantity,
        })),
        daysLate,
        ...(daysLate > 0 && reason ? { delayReason: reason } : {}),
        shortShipment,
      },
    });
    const putawayAt = now + this.supplierRng.int(30, 120) * MIN;
    this.at(putawayAt, () => this.putAway(po.receivingLocationId, lines.map((l) => ({ materialId: l.line.materialId, quantity: l.quantity })), putawayAt));
  }

  private putAway(from: Id, items: Array<{ materialId: Id; quantity: number }>, now: number) {
    for (const item of items) {
      this.emit("INVENTORY_TRANSFERRED", now, {
        transfer: {
          id: this.nextId("TRF"),
          itemId: item.materialId,
          itemKind: "RAW_MATERIAL",
          quantity: item.quantity,
          fromLocationId: from,
          toLocationId: this.idx.materials.get(item.materialId)!.storageLocationId,
          reason: "PUTAWAY",
        },
      });
    }
    this.retryBlocked(now);
    this.dispatch(now);
  }

  // ----- shop floor ---------------------------------------------------------

  private pendingOps(order: ProductionOrder): ProductionOperation[] {
    return order.operationIds.map((id) => this.state.productionOperations[id]);
  }

  private startableOp(op: ProductionOperation): boolean {
    const order = this.state.productionOrders[op.productionOrderId];
    return (
      op.status === "PENDING" &&
      order.status === "RUNNING" &&
      this.pendingOps(order).filter((o) => o.sequence < op.sequence).every((o) => o.status === "COMPLETED")
    );
  }

  private dispatch(now: number) {
    if (!inShift(now)) return;
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const ws of this.master.workstations) {
        const rt = this.state.workstations[ws.id];
        if (rt.status !== "IDLE" || rt.pausedOperationId) continue;
        const byDue = (a: ProductionOrder, b: ProductionOrder) => a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id);
        const orders = Object.values(this.state.productionOrders);

        if (ws.kind === "ASSEMBLY") {
          // Rework returns to the station that built the unit and has priority.
          const reworkOrder = orders
            .filter((o) => o.status === "RUNNING" && o.assignedWorkstationId === ws.id)
            .sort(byDue)
            .find((o) => this.pendingOps(o).some((op) => op.type === "REWORK" && this.startableOp(op)));
          if (reworkOrder) {
            const op = this.pendingOps(reworkOrder).find((x) => x.type === "REWORK" && this.startableOp(x))!;
            this.startOperation(op, ws.id, now);
            progressed = true;
            continue;
          }
          const next = orders.filter((o) => o.status === "WAITING").sort(byDue)[0];
          if (next) {
            this.startOrder(next, ws.id, now);
            progressed = true;
          }
        } else {
          const candidates = orders
            .filter((o) => o.status === "RUNNING")
            .sort(byDue)
            .flatMap((o) => this.pendingOps(o).filter((op) => op.type === "FINAL_TEST" && this.startableOp(op)));
          if (candidates.length > 0) {
            this.startOperation(candidates[0], ws.id, now);
            progressed = true;
          }
        }
      }
    }
  }

  private startOrder(order: ProductionOrder, wsId: Id, now: number) {
    const ws = this.idx.workstations.get(wsId)!;
    this.emit("MATERIAL_CONSUMED", now, {
      productionOrderId: order.id,
      consumptions: order.reservations.map((r) => ({
        materialId: r.materialId,
        quantity: r.quantity,
        fromLocationId: r.locationId,
        toLocationId: ws.locationId,
      })),
    });
    this.emit("PRODUCTION_STARTED", now, { productionOrderId: order.id, workstationId: wsId, assignmentId: this.nextId("ASG") });
    this.startOperation(this.state.productionOperations[order.operationIds[0]], wsId, now);
  }

  private startOperation(op: ProductionOperation, wsId: Id, now: number) {
    const ws = this.idx.workstations.get(wsId)!;
    this.emit("OPERATION_STARTED", now, { productionOperationId: op.id, productionOrderId: op.productionOrderId, workstationId: wsId });
    const variability = this.opsRng.float(0.92, 1.12);
    const minutes = Math.max(1, Math.round(op.plannedMinutes * ws.durationFactor * variability));
    this.scheduleOperationEnd(op.id, now + minutes * MIN);
  }

  private scheduleOperationEnd(opId: Id, endsAt: number) {
    const token = ++this.tokenCounter;
    this.opRuntime.set(opId, { endsAt, token });
    // Operations always run to completion, even past the horizon (state stays RUNNING).
    this.at(endsAt, () => this.onOperationEnd(opId, token, endsAt));
  }

  private onOperationEnd(opId: Id, token: number, now: number) {
    const rt = this.opRuntime.get(opId);
    if (!rt || rt.token !== token) return; // superseded by a machine failure
    const op = this.state.productionOperations[opId];
    const order = this.state.productionOrders[op.productionOrderId];
    const wsId = op.workstationId!;
    const base = { productionOperationId: opId, productionOrderId: order.id, workstationId: wsId };

    if (op.type === "FINAL_TEST") {
      this.completeInspection(op, order, wsId, now);
      this.emit("OPERATION_COMPLETED", now, base);
      const fresh = this.state.productionOrders[order.id];
      if (this.pendingOps(fresh).every((o) => o.status === "COMPLETED")) {
        this.emit("FINISHED_GOODS_RECEIVED", now, {
          productionOrderId: order.id,
          productId: order.productId,
          quantity: fresh.approvedQuantity - fresh.finishedGoodsReceivedQuantity,
          locationId: this.idx.products.get(order.productId)!.finishedGoodsLocationId,
        });
        this.allocateFinishedGoods(now);
        this.planProduction(now);
      }
    } else {
      this.emit("OPERATION_COMPLETED", now, base);
      if (!op.isRework) {
        const next = this.pendingOps(order).find((o) => o.status === "PENDING");
        if (next && ASSEMBLY_TYPES.includes(next.type)) {
          this.startOperation(next, wsId, now); // same station keeps the job
        } else {
          this.emit("PRODUCTION_COMPLETED", now, { productionOrderId: order.id, workstationId: wsId, quantityProduced: order.quantity });
        }
      }
    }
    this.dispatch(now);
  }

  private completeInspection(op: ProductionOperation, order: ProductionOrder, wsId: Id, now: number) {
    const product = this.idx.products.get(order.productId)!;
    const round = order.inspectionIds.length + 1;
    const interrupted = this.pendingOps(order)
      .filter((o) => ASSEMBLY_TYPES.includes(o.type))
      .flatMap((o) => o.interruptedByDowntimeIds);
    const rate = product.baseDefectRate * (round === 1 ? 1 : 0.5) * (round === 1 && interrupted.length > 0 ? 3 : 1);

    const codes: DefectCode[] = ["WIRING_ERROR", "LOOSE_TERMINATION", "FUNCTIONAL_TEST_FAIL", "ENCLOSURE_DAMAGE"];
    const counts = new Map<DefectCode, number>();
    let failed = 0;
    let rework = 0;
    for (let u = 0; u < op.quantity; u++) {
      if (!this.qualityRng.chance(rate)) continue;
      failed++;
      const code = this.qualityRng.weighted(codes, [0.4, 0.3, 0.2, 0.1]);
      counts.set(code, (counts.get(code) ?? 0) + 1);
      if (round === 1 && code !== "ENCLOSURE_DAMAGE") rework++;
    }
    const defects: DefectCount[] = [...counts.entries()].map(([code, quantity]) => ({ code, quantity }));
    const inspectionId = this.nextId("QI");
    this.emit("QUALITY_INSPECTION_COMPLETED", now, {
      inspection: {
        id: inspectionId,
        productionOrderId: order.id,
        operationId: op.id,
        workstationId: wsId,
        round,
        inspectedAt: iso(now),
        inspectedQuantity: op.quantity,
        passedQuantity: op.quantity - failed,
        failedQuantity: failed,
        reworkQuantity: rework,
        scrapQuantity: failed - rework,
        defects,
        ...(failed > 0
          ? { cause: round === 1 && interrupted.length > 0 ? { kind: "MACHINE_FAILURE" as const, downtimeId: interrupted[0] } : { kind: "PROCESS_VARIATION" as const } }
          : {}),
      },
    });
    if (rework > 0) {
      const lastSeq = Math.max(...this.pendingOps(order).map((o) => o.sequence));
      const make = (sequence: number, type: OperationType, kind: "ASSEMBLY" | "INSPECTION", minutes: number, isRework: boolean): ProductionOperation => ({
        id: `OP-${order.id}-${sequence}`,
        productionOrderId: order.id,
        sequence,
        type,
        workstationKind: kind,
        quantity: rework,
        plannedMinutes: minutes,
        isRework,
        status: "PENDING",
        pausedMinutes: 0,
        interruptedByDowntimeIds: [],
      });
      const finalTest = this.idx.routingByProduct.get(order.productId)!.steps.find((s) => s.operationType === "FINAL_TEST")!;
      this.emit("REWORK_REQUESTED", now, {
        productionOrderId: order.id,
        inspectionId,
        quantity: rework,
        operations: [
          make(lastSeq + 10, "REWORK", "ASSEMBLY", REWORK_SETUP_MINUTES + REWORK_MINUTES_PER_UNIT * rework, true),
          make(lastSeq + 20, "FINAL_TEST", "INSPECTION", finalTest.setupMinutes + finalTest.minutesPerUnit * rework, false),
        ],
      });
    }
  }

  private machineFails(wsId: Id, now: number, repairMinutes: number, code: string) {
    if (this.state.workstations[wsId].status === "DOWN") return;
    const downtimeId = this.nextId("DT");
    const runningOpId = this.state.workstations[wsId].currentOperationId;
    this.emit("MACHINE_FAILED", now, { downtimeId, workstationId: wsId, failureCode: code, expectedRepairMinutes: repairMinutes });

    if (runningOpId) {
      const rt = this.opRuntime.get(runningOpId)!;
      this.opRuntime.set(runningOpId, { endsAt: rt.endsAt, token: ++this.tokenCounter, remainingMs: Math.max(MIN, rt.endsAt - now) });
      const op = this.state.productionOperations[runningOpId];
      this.emit("PRODUCTION_BLOCKED", now, {
        productionOrderId: op.productionOrderId,
        reason: "MACHINE_DOWN",
        workstationId: wsId,
        operationId: runningOpId,
        downtimeId,
      });
    }
    const restoreAt = now + repairMinutes * MIN;
    this.at(restoreAt, () => this.machineRestored(wsId, downtimeId, restoreAt));
  }

  private machineRestored(wsId: Id, downtimeId: Id, now: number) {
    const pausedId = this.state.workstations[wsId].pausedOperationId;
    this.emit("MACHINE_RESTORED", now, { downtimeId, workstationId: wsId });
    if (pausedId) {
      const op = this.state.productionOperations[pausedId];
      this.emit("PRODUCTION_RESUMED", now, { productionOrderId: op.productionOrderId, operationId: pausedId, workstationId: wsId, downtimeId });
      const remaining = this.opRuntime.get(pausedId)?.remainingMs ?? MIN;
      this.scheduleOperationEnd(pausedId, now + remaining);
    }
    this.dispatch(now);
  }

  // ----- shipping -----------------------------------------------------------

  private shipOrders(now: number) {
    for (const order of this.openOrders()) {
      const allocated = order.lines.filter((l) => l.allocatedQuantity > 0);
      if (allocated.length === 0) continue;
      const complete = order.lines.every((l) => l.allocatedQuantity + l.shippedQuantity === l.quantity);
      const dueSoon = Date.parse(order.dueDate) - now <= DAY;
      if (!complete && !dueSoon) continue; // hold partials until due date nears
      const shipmentId = this.nextId("SHIP");
      this.emit("SHIPMENT_DISPATCHED", now, {
        shipment: {
          id: shipmentId,
          customerOrderId: order.id,
          customerId: order.customerId,
          dispatchedAt: iso(now),
          carrier: this.supplierRng.pick(CARRIERS),
          lines: allocated.map((l, i) => ({
            id: `${shipmentId}-L${i + 1}`,
            customerOrderLineId: l.id,
            productId: l.productId,
            quantity: l.allocatedQuantity,
            fromLocationId: this.idx.products.get(l.productId)!.finishedGoodsLocationId,
          })),
        },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit hash, hex encoded. */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function buildManifest(
  config: GeneratorConfig,
  events: FactoryEvent[],
  finalState: FactoryState,
): Manifest {
  const eventTypeCounts: Record<string, number> = {};
  for (const e of events) eventTypeCounts[e.type] = (eventTypeCounts[e.type] ?? 0) + 1;
  const start = Date.parse(config.startDate);
  return {
    schemaVersion: SCHEMA_VERSION,
    seed: config.seed,
    config,
    simulatedRange: { start: config.startDate, end: iso(start + config.days * DAY) },
    eventCount: events.length,
    eventTypeCounts,
    eventLogHash: fnv1a(JSON.stringify(events)),
    recordCounts: {
      materials: 0,
      purchaseOrders: Object.keys(finalState.purchaseOrders).length,
      receipts: Object.keys(finalState.receipts).length,
      inventoryTransactions: finalState.inventoryTransactions.length,
      productionOrders: Object.keys(finalState.productionOrders).length,
      productionOperations: Object.keys(finalState.productionOperations).length,
      qualityInspections: Object.keys(finalState.qualityInspections).length,
      customerOrders: Object.keys(finalState.customerOrders).length,
      shipments: Object.keys(finalState.shipments).length,
      downtimes: Object.keys(finalState.downtimes).length,
    },
  };
}

export function generateDataset(overrides: Partial<GeneratorConfig> = {}): ManufacturingDataset {
  const config = resolveConfig(overrides);
  const master = buildMasterData(config);
  const initialState = buildInitialState(config, master);
  const working = structuredClone(initialState);
  const sim = new Simulation(config, master, working);
  const events = sim.run();
  const manifest = buildManifest(config, events, working);
  manifest.recordCounts.materials = master.materials.length;
  return { manifest, master, initialState, events, finalState: working };
}
