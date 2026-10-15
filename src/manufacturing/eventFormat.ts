/**
 * Human-readable descriptions of factory events for the activity feed.
 * Pure: lookups come from MasterData only.
 */
import { factoryObjectsForEvent } from "./mapping.ts";
import type { FactoryEvent, Id, MasterData } from "./types.ts";

export interface FeedEntry {
  id: Id;
  sequence: number;
  timestamp: string;
  type: string;
  text: string;
  /** Primary station/location label, when the event has one. */
  where?: string;
  /** 3D object ids the event relates to (first is the primary one). */
  objectIds: Id[];
}

const pretty = (type: string) => type.toLowerCase().replace(/_/g, " ");

export function describeEvent(event: FactoryEvent, master: MasterData): FeedEntry {
  const material = (id: Id) => master.materials.find((m) => m.id === id)?.description ?? id;
  const product = (id: Id) => master.products.find((p) => p.id === id)?.name ?? id;
  const place = (id: Id) =>
    master.workstations.find((w) => w.id === id)?.name ?? master.locations.find((l) => l.id === id)?.name ?? id;

  let text: string;
  switch (event.type) {
    case "PURCHASE_ORDER_CREATED": {
      const po = event.payload.purchaseOrder;
      text = `Purchase order ${po.id} created (${po.lines.length} line${po.lines.length === 1 ? "" : "s"})`;
      break;
    }
    case "MATERIAL_RECEIVED": {
      const r = event.payload.receipt;
      const units = r.lines.reduce((s, l) => s + l.quantity, 0);
      text = `Received ${units} units against ${r.purchaseOrderId}${r.daysLate > 0 ? ` (${r.daysLate} d late)` : ""}`;
      break;
    }
    case "INVENTORY_TRANSFERRED": {
      const t = event.payload.transfer;
      const name = t.itemKind === "RAW_MATERIAL" ? material(t.itemId) : product(t.itemId);
      text = `Moved ${t.quantity} × ${name} to ${place(t.toLocationId)}`;
      break;
    }
    case "CUSTOMER_ORDER_CREATED":
      text = `Customer order ${event.payload.customerOrder.id} received`;
      break;
    case "CUSTOMER_ORDER_CANCELLED":
      text = `Customer order ${event.payload.customerOrderId} cancelled`;
      break;
    case "PRODUCTION_ORDER_CREATED": {
      const o = event.payload.productionOrder;
      text = `${o.id} planned: ${o.quantity} × ${product(o.productId)}`;
      break;
    }
    case "PRODUCTION_ORDER_RELEASED":
      text = `${event.payload.productionOrderId} released, materials reserved`;
      break;
    case "PRODUCTION_ORDER_CANCELLED":
      text = `${event.payload.productionOrderId} cancelled (demand cancelled)`;
      break;
    case "PRODUCTION_BLOCKED": {
      const p = event.payload;
      text =
        p.reason === "MACHINE_DOWN"
          ? `${p.productionOrderId} blocked: machine down`
          : `${p.productionOrderId} blocked: short of ${(p.shortages ?? []).map((s) => material(s.materialId)).join(", ") || "material"}`;
      break;
    }
    case "PRODUCTION_RESUMED":
      text = `${event.payload.productionOrderId} resumed after repair`;
      break;
    case "MATERIAL_CONSUMED":
      text = `Materials issued to ${event.payload.productionOrderId}`;
      break;
    case "PRODUCTION_STARTED":
      text = `${event.payload.productionOrderId} started at ${place(event.payload.workstationId)}`;
      break;
    case "OPERATION_STARTED":
      text = `${event.payload.productionOrderId}: operation ${event.payload.productionOperationId} started`;
      break;
    case "OPERATION_COMPLETED":
      text = `${event.payload.productionOrderId}: operation ${event.payload.productionOperationId} completed`;
      break;
    case "PRODUCTION_COMPLETED":
      text = `${event.payload.productionOrderId} assembly done (${event.payload.quantityProduced} units)`;
      break;
    case "QUALITY_INSPECTION_COMPLETED": {
      const i = event.payload.inspection;
      text = `${i.productionOrderId} inspected (round ${i.round}): ${i.passedQuantity}/${i.inspectedQuantity} passed`;
      break;
    }
    case "REWORK_REQUESTED":
      text = `${event.payload.productionOrderId} sent to rework (${event.payload.quantity} units)`;
      break;
    case "FINISHED_GOODS_RECEIVED":
      text = `${event.payload.quantity} × ${product(event.payload.productId)} received into finished goods`;
      break;
    case "FINISHED_GOODS_ALLOCATED":
      text = `${event.payload.quantity} × ${product(event.payload.productId)} allocated to ${event.payload.customerOrderId}`;
      break;
    case "SHIPMENT_DISPATCHED":
      text = `Shipment ${event.payload.shipment.id} dispatched for ${event.payload.shipment.customerOrderId}`;
      break;
    case "MACHINE_FAILED":
      text = `${place(event.payload.workstationId)} failed (${event.payload.failureCode})`;
      break;
    case "MACHINE_RESTORED":
      text = `${place(event.payload.workstationId)} restored`;
      break;
    default:
      text = pretty((event as FactoryEvent).type);
  }

  const objectIds = factoryObjectsForEvent(event).objectIds;
  const primary = event.entities.workstationId ?? objectIds[0];
  const ids = primary ? [primary, ...objectIds.filter((o) => o !== primary)] : objectIds;
  return {
    id: event.id,
    sequence: event.sequence,
    timestamp: event.timestamp,
    type: event.type,
    text,
    where: primary ? place(primary) : undefined,
    objectIds: ids,
  };
}

/** Bounded, newest-last ring of recent feed entries. Cleared on reset/seek via `epoch`. */
export class ActivityLog {
  private entries: FeedEntry[] = [];
  private epoch = 0;
  /** Bumps whenever contents change; lets the UI skip redundant renders. */
  version = 0;

  private readonly capacity: number;

  constructor(capacity = 200) {
    this.capacity = capacity;
  }

  push(entry: FeedEntry, epoch: number): void {
    if (epoch !== this.epoch) {
      this.entries = [];
      this.epoch = epoch;
    }
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
    this.version++;
  }

  /** Drop everything, e.g. when the clock was reset or seeked. */
  sync(epoch: number): void {
    if (epoch === this.epoch) return;
    this.entries = [];
    this.epoch = epoch;
    this.version++;
  }

  /** Newest first. */
  latest(n: number, filter?: (e: FeedEntry) => boolean): FeedEntry[] {
    const out: FeedEntry[] = [];
    for (let i = this.entries.length - 1; i >= 0 && out.length < n; i--) {
      if (!filter || filter(this.entries[i])) out.push(this.entries[i]);
    }
    return out;
  }
}
