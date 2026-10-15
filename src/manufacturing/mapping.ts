/**
 * Stable mapping between manufacturing entities and existing 3D factory objects.
 *
 * Location and workstation IDs ARE the factoryLayout object IDs
 * (REC-001, INV-001, ASM-001, QC-001, SHP-001 ...), so the mapping is mostly
 * identity. These helpers answer "which meshes should react to this event /
 * show this record?" without any rendering code.
 */
import type { FactoryEvent, FactoryState, Id, MasterData } from "./types.ts";

/** Material that enters or leaves the factory (no mesh). */
export const EXTERNAL = "EXTERNAL";

export interface MaterialFlow {
  from: Id | typeof EXTERNAL;
  to: Id | typeof EXTERNAL;
  itemId?: Id;
  quantity?: number;
}

export interface EventVisualRefs {
  /** Factory objects that should highlight / update for this event. */
  objectIds: Id[];
  /** Movements to animate. */
  flows: MaterialFlow[];
}

const uniq = (ids: Array<Id | undefined>): Id[] => [...new Set(ids.filter((x): x is Id => !!x))];

/**
 * `before` is the state *before* the event (only needed to resolve the QC
 * station for FINISHED_GOODS_RECEIVED; everything else comes from the payload).
 */
export function factoryObjectsForEvent(event: FactoryEvent, before?: FactoryState): EventVisualRefs {
  switch (event.type) {
    case "PURCHASE_ORDER_CREATED":
      return { objectIds: [event.payload.purchaseOrder.receivingLocationId], flows: [] };
    case "MATERIAL_RECEIVED": {
      const r = event.payload.receipt;
      return {
        objectIds: [r.locationId],
        flows: r.lines.map((l) => ({ from: EXTERNAL, to: r.locationId, itemId: l.materialId, quantity: l.quantity })),
      };
    }
    case "INVENTORY_TRANSFERRED": {
      const t = event.payload.transfer;
      return {
        objectIds: [t.fromLocationId, t.toLocationId],
        flows: [{ from: t.fromLocationId, to: t.toLocationId, itemId: t.itemId, quantity: t.quantity }],
      };
    }
    case "PRODUCTION_ORDER_RELEASED":
      return { objectIds: uniq(event.payload.reservations.map((r) => r.locationId)), flows: [] };
    case "MATERIAL_CONSUMED": {
      const c = event.payload.consumptions;
      return {
        objectIds: uniq(c.flatMap((x) => [x.fromLocationId, x.toLocationId])),
        flows: c.map((x) => ({ from: x.fromLocationId, to: x.toLocationId, itemId: x.materialId, quantity: x.quantity })),
      };
    }
    case "PRODUCTION_STARTED":
    case "OPERATION_STARTED":
    case "OPERATION_COMPLETED":
    case "MACHINE_FAILED":
    case "MACHINE_RESTORED":
    case "PRODUCTION_RESUMED":
      return { objectIds: [event.payload.workstationId], flows: [] };
    case "PRODUCTION_BLOCKED": {
      const p = event.payload;
      if (p.reason === "MACHINE_DOWN") return { objectIds: uniq([p.workstationId]), flows: [] };
      return { objectIds: [], flows: [] }; // shortage: highlight the racks holding the short materials via selectors
    }
    case "PRODUCTION_COMPLETED":
      return { objectIds: [event.payload.workstationId], flows: [] };
    case "QUALITY_INSPECTION_COMPLETED":
      return { objectIds: [event.payload.inspection.workstationId], flows: [] };
    case "FINISHED_GOODS_RECEIVED": {
      const p = event.payload;
      const order = before?.productionOrders[p.productionOrderId];
      const qcOp = order?.operationIds
        .map((id) => before!.productionOperations[id])
        .filter((o) => o.type === "FINAL_TEST" && o.workstationId)
        .pop();
      const from = qcOp?.workstationId;
      return {
        objectIds: uniq([from, p.locationId]),
        flows: from ? [{ from, to: p.locationId, itemId: p.productId, quantity: p.quantity }] : [],
      };
    }
    case "FINISHED_GOODS_ALLOCATED":
      return { objectIds: [event.payload.locationId], flows: [] };
    case "SHIPMENT_DISPATCHED": {
      const s = event.payload.shipment;
      return {
        objectIds: uniq(s.lines.map((l) => l.fromLocationId)),
        flows: s.lines.map((l) => ({ from: l.fromLocationId, to: EXTERNAL, itemId: l.productId, quantity: l.quantity })),
      };
    }
    default:
      return { objectIds: [], flows: [] };
  }
}

export type MappedEntity =
  | { kind: "location"; id: Id }
  | { kind: "workstation"; id: Id }
  | { kind: "material"; id: Id }
  | { kind: "product"; id: Id }
  | { kind: "purchaseOrder"; id: Id }
  | { kind: "productionOrder"; id: Id }
  | { kind: "customerOrder"; id: Id }
  | { kind: "shipment"; id: Id };

/** Which 3D objects "own" a business record (for click-to-inspect / highlighting). */
export function factoryObjectsForEntity(entity: MappedEntity, state: FactoryState, master: MasterData): Id[] {
  switch (entity.kind) {
    case "location":
    case "workstation":
      return [entity.id];
    case "material": {
      const m = master.materials.find((x) => x.id === entity.id);
      return m ? [m.storageLocationId] : [];
    }
    case "product": {
      const p = master.products.find((x) => x.id === entity.id);
      return p ? [p.finishedGoodsLocationId] : [];
    }
    case "purchaseOrder": {
      const po = state.purchaseOrders[entity.id];
      return po ? [po.receivingLocationId] : [];
    }
    case "productionOrder": {
      const o = state.productionOrders[entity.id];
      return o ? uniq([o.currentLocationId ?? o.assignedWorkstationId]) : [];
    }
    case "customerOrder": {
      const o = state.customerOrders[entity.id];
      if (!o) return [];
      return uniq(o.lines.map((l) => master.products.find((p) => p.id === l.productId)?.finishedGoodsLocationId));
    }
    case "shipment": {
      const s = state.shipments[entity.id];
      return s ? uniq(s.lines.map((l) => l.fromLocationId)) : [];
    }
  }
}

/** Business records attached to a 3D object (inverse mapping, for the inspection panel). */
export function recordsForFactoryObject(objectId: Id, state: FactoryState, master: MasterData) {
  const ws = master.workstations.find((w) => w.id === objectId);
  const location = master.locations.find((l) => l.id === objectId);
  return {
    location,
    workstation: ws,
    workstationRuntime: ws ? state.workstations[ws.id] : undefined,
    inventory: Object.values(state.inventory).filter((b) => b.locationId === objectId && b.onHand > 0),
    productionOrders: Object.values(state.productionOrders).filter(
      (o) => o.assignedWorkstationId === objectId || o.currentLocationId === objectId,
    ),
    openPurchaseOrders: Object.values(state.purchaseOrders).filter(
      (p) => p.receivingLocationId === objectId && p.status !== "RECEIVED",
    ),
  };
}
