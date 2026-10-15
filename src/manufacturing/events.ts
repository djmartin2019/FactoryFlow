import type {
  EventEntityRefs,
  EventPayloads,
  EventType,
  FactoryEvent,
  Id,
  IsoTimestamp,
} from "./types.ts";

export function eventIdFor(sequence: number): Id {
  return `EVT-${String(sequence).padStart(6, "0")}`;
}

/** Entity IDs an event touches. Pure function of type + payload. */
export function entityRefsFor<T extends EventType>(type: T, payload: EventPayloads[T]): EventEntityRefs {
  // The switch narrows by `type`; payload is cast per branch.
  const p = payload as any;
  switch (type) {
    case "PURCHASE_ORDER_CREATED":
      return {
        purchaseOrderId: p.purchaseOrder.id,
        supplierId: p.purchaseOrder.supplierId,
        materialIds: p.purchaseOrder.lines.map((l: any) => l.materialId),
        locationIds: [p.purchaseOrder.receivingLocationId],
      };
    case "MATERIAL_RECEIVED":
      return {
        purchaseOrderId: p.receipt.purchaseOrderId,
        supplierId: p.receipt.supplierId,
        materialIds: p.receipt.lines.map((l: any) => l.materialId),
        locationIds: [p.receipt.locationId],
      };
    case "INVENTORY_TRANSFERRED":
      return {
        materialIds: p.transfer.itemKind === "RAW_MATERIAL" ? [p.transfer.itemId] : undefined,
        productId: p.transfer.itemKind === "FINISHED_GOOD" ? p.transfer.itemId : undefined,
        locationIds: [p.transfer.fromLocationId, p.transfer.toLocationId],
      };
    case "CUSTOMER_ORDER_CREATED":
      return { customerOrderId: p.customerOrder.id, customerId: p.customerOrder.customerId };
    case "CUSTOMER_ORDER_CANCELLED":
      return { customerOrderId: p.customerOrderId };
    case "PRODUCTION_ORDER_CREATED":
      return { productionOrderId: p.productionOrder.id, productId: p.productionOrder.productId };
    case "PRODUCTION_ORDER_RELEASED":
      return {
        productionOrderId: p.productionOrderId,
        materialIds: p.reservations.map((r: any) => r.materialId),
        locationIds: [...new Set<Id>(p.reservations.map((r: any) => r.locationId))],
      };
    case "PRODUCTION_ORDER_CANCELLED":
      return { productionOrderId: p.productionOrderId };
    case "PRODUCTION_BLOCKED":
      return {
        productionOrderId: p.productionOrderId,
        workstationId: p.workstationId,
        productionOperationId: p.operationId,
        downtimeId: p.downtimeId,
        materialIds: p.shortages?.map((s: any) => s.materialId),
      };
    case "PRODUCTION_RESUMED":
      return {
        productionOrderId: p.productionOrderId,
        productionOperationId: p.operationId,
        workstationId: p.workstationId,
        downtimeId: p.downtimeId,
      };
    case "MATERIAL_CONSUMED":
      return {
        productionOrderId: p.productionOrderId,
        materialIds: p.consumptions.map((c: any) => c.materialId),
        locationIds: [...new Set<Id>(p.consumptions.flatMap((c: any) => [c.fromLocationId, c.toLocationId]))],
      };
    case "PRODUCTION_STARTED":
      return { productionOrderId: p.productionOrderId, workstationId: p.workstationId };
    case "OPERATION_STARTED":
    case "OPERATION_COMPLETED":
      return {
        productionOrderId: p.productionOrderId,
        productionOperationId: p.productionOperationId,
        workstationId: p.workstationId,
      };
    case "PRODUCTION_COMPLETED":
      return { productionOrderId: p.productionOrderId, workstationId: p.workstationId };
    case "QUALITY_INSPECTION_COMPLETED":
      return {
        productionOrderId: p.inspection.productionOrderId,
        productionOperationId: p.inspection.operationId,
        workstationId: p.inspection.workstationId,
        inspectionId: p.inspection.id,
        downtimeId: p.inspection.cause?.downtimeId,
      };
    case "REWORK_REQUESTED":
      return { productionOrderId: p.productionOrderId, inspectionId: p.inspectionId };
    case "FINISHED_GOODS_RECEIVED":
      return { productionOrderId: p.productionOrderId, productId: p.productId, locationIds: [p.locationId] };
    case "FINISHED_GOODS_ALLOCATED":
      return { customerOrderId: p.customerOrderId, productId: p.productId, locationIds: [p.locationId] };
    case "SHIPMENT_DISPATCHED":
      return {
        shipmentId: p.shipment.id,
        customerOrderId: p.shipment.customerOrderId,
        customerId: p.shipment.customerId,
        locationIds: [...new Set<Id>(p.shipment.lines.map((l: any) => l.fromLocationId))],
      };
    case "MACHINE_FAILED":
    case "MACHINE_RESTORED":
      return { workstationId: p.workstationId, downtimeId: p.downtimeId };
    default:
      return {};
  }
}

export function buildEvent<T extends EventType>(
  sequence: number,
  timestamp: IsoTimestamp,
  type: T,
  payload: EventPayloads[T],
): FactoryEvent<T> {
  const entities = entityRefsFor(type, payload);
  // Drop undefined keys so the event is stable under JSON round-trips.
  for (const k of Object.keys(entities) as Array<keyof EventEntityRefs>) {
    if (entities[k] === undefined) delete entities[k];
  }
  return { id: eventIdFor(sequence), sequence, timestamp, type, entities, payload } as FactoryEvent<T>;
}
