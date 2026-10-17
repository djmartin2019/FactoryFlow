/**
 * The simulation wire format as data: one entry per domain entity and per event payload, plus status codes and event
 * kinds. Each table is typed against the domain types, so adding a field to a domain interface or an `EventType` fails
 * compilation here until the wire format says what to do with it (and `tests/sources/simulationRoundTrip.test.ts`
 * fails if the new field is typed wrongly). See `codec.ts` for the shorthand.
 */
import type {
  BillOfMaterials,
  BlockReason,
  BomLine,
  ChangeoverRule,
  Customer,
  CustomerOrder,
  CustomerOrderLine,
  DefectCount,
  Department,
  Downtime,
  Equipment,
  EquipmentRuntime,
  EventPayloads,
  EventType,
  FactoryLocation,
  FactoryState,
  InventoryBalance,
  InventoryTransaction,
  InventoryTransactionType,
  InventoryTransfer,
  ItemKind,
  MasterData,
  Material,
  MaterialConsumption,
  MaterialReservation,
  MaterialShortage,
  OperationStatus,
  Product,
  ProductionOperation,
  ProductionOrder,
  ProductionOrderStatus,
  ProductionStage,
  PurchaseOrder,
  PurchaseOrderLine,
  PurchaseOrderStatus,
  QualityInspection,
  Routing,
  RoutingStep,
  Shipment,
  ShipmentLine,
  Supplier,
  SupplierReceipt,
  SupplierReceiptLine,
  WorkCenter,
  Workstation,
  WorkstationAssignment,
  WorkstationRunStatus,
  WorkstationRuntime,
  CustomerOrderStatus,
} from "../../manufacturing/types.ts";
import { createCodec, type EntitySpec } from "./codec.ts";

// ---------------------------------------------------------------------------
// Status codes (exhaustive per domain union)
// ---------------------------------------------------------------------------

const ITEM_KIND: Record<ItemKind, string> = { RAW_MATERIAL: "RM", FINISHED_GOOD: "FG" };
const PRODUCTION_ORDER_STATUS: Record<ProductionOrderStatus, string> = {
  PLANNED: "PLN", WAITING: "WTG", RUNNING: "RUN", BLOCKED: "BLK", COMPLETED: "CMP", CANCELLED: "CXL",
};
const PRODUCTION_STAGE: Record<ProductionStage, string> = {
  PLANNING: "PLAN", QUEUED: "QUE", ASSEMBLY: "ASM", AWAITING_QC: "AQC", QUALITY: "QA", REWORK: "RWK", FINISHED: "FIN", CANCELLED: "CXL",
};
const BLOCK_REASON: Record<BlockReason, string> = { MATERIAL_SHORTAGE: "SHORT", MACHINE_DOWN: "MDOWN" };
const OPERATION_STATUS: Record<OperationStatus, string> = { PENDING: "PEND", RUNNING: "RUN", PAUSED: "HOLD", COMPLETED: "DONE" };
const PURCHASE_ORDER_STATUS: Record<PurchaseOrderStatus, string> = { OPEN: "OPN", PARTIALLY_RECEIVED: "PRC", RECEIVED: "RCV" };
const CUSTOMER_ORDER_STATUS: Record<CustomerOrderStatus, string> = { OPEN: "OPN", PARTIALLY_SHIPPED: "PSH", SHIPPED: "SHP", CANCELLED: "CXL" };
const WORKSTATION_RUN_STATUS: Record<WorkstationRunStatus, string> = { IDLE: "IDLE", RUNNING: "RUN", DOWN: "DOWN" };
const INVENTORY_TRANSACTION_TYPE: Record<InventoryTransactionType, string> = {
  RECEIPT: "RCPT", TRANSFER_OUT: "XFER_OUT", TRANSFER_IN: "XFER_IN", RESERVATION: "RSV", RESERVATION_RELEASED: "RSV_REL",
  CONSUMPTION: "CONS", FG_RECEIPT: "FG_RCPT", FG_ALLOCATION: "FG_ALLOC", FG_ALLOCATION_RELEASED: "FG_ALLOC_REL", SHIPMENT: "SHIP",
};

export const ENUM_CODES = {
  ItemKind: ITEM_KIND,
  ProductionOrderStatus: PRODUCTION_ORDER_STATUS,
  ProductionStage: PRODUCTION_STAGE,
  BlockReason: BLOCK_REASON,
  OperationStatus: OPERATION_STATUS,
  PurchaseOrderStatus: PURCHASE_ORDER_STATUS,
  CustomerOrderStatus: CUSTOMER_ORDER_STATUS,
  WorkstationRunStatus: WORKSTATION_RUN_STATUS,
  InventoryTransactionType: INVENTORY_TRANSACTION_TYPE,
} as const;

// ---------------------------------------------------------------------------
// Event kinds
// ---------------------------------------------------------------------------

export const EVENT_KINDS: Record<EventType, string> = {
  PURCHASE_ORDER_CREATED: "purchasing.po_created",
  MATERIAL_RECEIVED: "purchasing.material_received",
  INVENTORY_TRANSFERRED: "inventory.transferred",
  CUSTOMER_ORDER_CREATED: "sales.order_created",
  CUSTOMER_ORDER_CANCELLED: "sales.order_cancelled",
  PRODUCTION_ORDER_CREATED: "production.order_created",
  PRODUCTION_ORDER_RELEASED: "production.order_released",
  PRODUCTION_ORDER_CANCELLED: "production.order_cancelled",
  PRODUCTION_BLOCKED: "production.blocked",
  PRODUCTION_RESUMED: "production.resumed",
  MATERIAL_CONSUMED: "production.material_consumed",
  PRODUCTION_STARTED: "production.started",
  OPERATION_STARTED: "production.operation_started",
  OPERATION_COMPLETED: "production.operation_completed",
  PRODUCTION_COMPLETED: "production.completed",
  QUALITY_INSPECTION_COMPLETED: "quality.inspection_completed",
  REWORK_REQUESTED: "quality.rework_requested",
  FINISHED_GOODS_RECEIVED: "inventory.finished_goods_received",
  FINISHED_GOODS_ALLOCATED: "sales.finished_goods_allocated",
  SHIPMENT_DISPATCHED: "sales.shipment_dispatched",
  MACHINE_FAILED: "machine.failed",
  MACHINE_RESTORED: "machine.restored",
};

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

const entities = {
  Department: { id: "id", name: "str", kind: "str" } satisfies EntitySpec<Department>,
  FactoryLocation: { id: "id", name: "str", departmentId: "id", kind: "str", palletCapacity: "int" } satisfies EntitySpec<FactoryLocation>,
  Supplier: { id: "id", name: "str", leadTimeDays: "int", onTimeRate: "num", paymentTermsDays: "int", receivingLocationId: "id" } satisfies EntitySpec<Supplier>,
  Customer: { id: "id", name: "str", region: "str", paymentTermsDays: "int" } satisfies EntitySpec<Customer>,
  Material: {
    id: "id", sku: "str", description: "str", uom: "str", standardCostCents: "int", supplierId: "id", supplierPartNumber: "str",
    leadTimeDays: "int", storageLocationId: "id", unitsPerPallet: "qty", orderMultiple: "qty", initialCoverDays: "num", safetyDays: "num",
  } satisfies EntitySpec<Material>,
  BomLine: { materialId: "id", quantityPer: "qty" } satisfies EntitySpec<BomLine>,
  BillOfMaterials: { id: "id", productId: "id", version: "str", lines: "@BomLine[]" } satisfies EntitySpec<BillOfMaterials>,
  RoutingStep: {
    sequence: "int", workCenterId: "id?", operationType: "str", workstationKind: "str", setupMinutes: "min", minutesPerUnit: "min",
    requiredEquipment: "str[]?",
  } satisfies EntitySpec<RoutingStep>,
  Routing: { id: "id", productId: "id", steps: "@RoutingStep[]" } satisfies EntitySpec<Routing>,
  Product: {
    id: "id", sku: "str", name: "str", description: "str", bomId: "id", routingId: "id", standardCostCents: "int", listPriceCents: "int",
    finishedGoodsLocationId: "id", unitsPerPallet: "qty", baseDefectRate: "num",
  } satisfies EntitySpec<Product>,
  WorkCenter: { id: "id", name: "str", kind: "str" } satisfies EntitySpec<WorkCenter>,
  Equipment: { id: "id", name: "str", kind: "str" } satisfies EntitySpec<Equipment>,
  ChangeoverRule: { workCenterId: "id", fromProductId: "id", toProductId: "id", setupMinutes: "min" } satisfies EntitySpec<ChangeoverRule>,
  Workstation: {
    id: "id", name: "str", kind: "str", workCenterIds: "id[]?", departmentId: "id", locationId: "id", concurrentJobs: "int", durationFactor: "num",
  } satisfies EntitySpec<Workstation>,

  InventoryBalance: { locationId: "id", itemId: "id", itemKind: "enum:ItemKind", onHand: "int", reserved: "int" } satisfies EntitySpec<InventoryBalance>,
  InventoryTransaction: {
    id: "id", eventId: "id", timestamp: "ts", type: "enum:InventoryTransactionType", itemId: "id", itemKind: "enum:ItemKind", locationId: "id",
    onHandDelta: "int", reservedDelta: "int", referenceType: "str", referenceId: "id",
  } satisfies EntitySpec<InventoryTransaction>,
  InventoryTransfer: {
    id: "id", itemId: "id", itemKind: "enum:ItemKind", quantity: "qty", fromLocationId: "id", toLocationId: "id", reason: "str",
  } satisfies EntitySpec<InventoryTransfer>,

  PurchaseOrderLine: {
    id: "id", lineNumber: "int", materialId: "id", orderedQuantity: "qty", receivedQuantity: "qty", unitCostCents: "int",
  } satisfies EntitySpec<PurchaseOrderLine>,
  PurchaseOrder: {
    id: "id", supplierId: "id", createdAt: "ts", promisedDeliveryAt: "ts", receivingLocationId: "id", status: "enum:PurchaseOrderStatus",
    reason: "str", lines: "@PurchaseOrderLine[]", totalCents: "int",
  } satisfies EntitySpec<PurchaseOrder>,
  SupplierReceiptLine: { id: "id", purchaseOrderLineId: "id", materialId: "id", quantity: "qty" } satisfies EntitySpec<SupplierReceiptLine>,
  SupplierReceipt: {
    id: "id", purchaseOrderId: "id", supplierId: "id", receivedAt: "ts", locationId: "id", lines: "@SupplierReceiptLine[]", daysLate: "int",
    delayReason: "str?", shortShipment: "bool",
  } satisfies EntitySpec<SupplierReceipt>,

  MaterialReservation: { materialId: "id", quantity: "qty", locationId: "id" } satisfies EntitySpec<MaterialReservation>,
  MaterialShortage: { materialId: "id", required: "qty", available: "qty", expectedPurchaseOrderIds: "id[]" } satisfies EntitySpec<MaterialShortage>,
  MaterialConsumption: { materialId: "id", quantity: "qty", fromLocationId: "id", toLocationId: "id" } satisfies EntitySpec<MaterialConsumption>,
  ProductionOrder: {
    id: "id", productId: "id", quantity: "qty", status: "enum:ProductionOrderStatus", stage: "enum:ProductionStage", createdAt: "ts", dueDate: "ts",
    demandLineIds: "id[]", releasedAt: "ts?", startedAt: "ts?", productionCompletedAt: "ts?", completedAt: "ts?", assignedWorkstationId: "id?",
    currentLocationId: "id?", reservations: "@MaterialReservation[]", materialsConsumed: "bool", blockReason: "enum:BlockReason?", blockedAt: "ts?",
    operationIds: "id[]", inspectionIds: "id[]", wipQuantity: "qty", awaitingQcQuantity: "qty", reworkPendingQuantity: "qty", approvedQuantity: "qty",
    scrappedQuantity: "qty", finishedGoodsReceivedQuantity: "qty",
  } satisfies EntitySpec<ProductionOrder>,
  ProductionOperation: {
    id: "id", productionOrderId: "id", sequence: "int", type: "str", workstationKind: "str", workCenterId: "id?", quantity: "qty", plannedMinutes: "min",
    standardSetupMinutes: "min?", requiredEquipment: "str[]?", isRework: "bool", status: "enum:OperationStatus", workstationId: "id?", setupMinutes: "min?",
    changeoverFromProductId: "id?", equipmentIds: "id[]?", startedAt: "ts?", completedAt: "ts?", pausedAt: "ts?", pausedMinutes: "min",
    interruptedByDowntimeIds: "id[]",
  } satisfies EntitySpec<ProductionOperation>,
  WorkstationAssignment: {
    id: "id", productionOrderId: "id", workstationId: "id", assignedAt: "ts", releasedAt: "ts?",
  } satisfies EntitySpec<WorkstationAssignment>,
  DefectCount: { code: "str", quantity: "qty" } satisfies EntitySpec<DefectCount>,
  InspectionCause: { kind: "str", downtimeId: "id?" } satisfies EntitySpec<NonNullable<QualityInspection["cause"]>>,
  QualityInspection: {
    id: "id", productionOrderId: "id", operationId: "id", workstationId: "id", round: "int", inspectedAt: "ts", inspectedQuantity: "qty",
    passedQuantity: "qty", failedQuantity: "qty", reworkQuantity: "qty", scrapQuantity: "qty", defects: "@DefectCount[]", cause: "@InspectionCause?",
  } satisfies EntitySpec<QualityInspection>,
  WorkstationRuntime: {
    workstationId: "id", status: "enum:WorkstationRunStatus", currentOperationId: "id?", pausedOperationId: "id?", lastProductByWorkCenter: "id{}?", since: "ts",
  } satisfies EntitySpec<WorkstationRuntime>,
  EquipmentRuntime: { equipmentId: "id", currentOperationId: "id?" } satisfies EntitySpec<EquipmentRuntime>,
  Downtime: {
    id: "id", workstationId: "id", failureCode: "str", failedAt: "ts", expectedRepairMinutes: "min", restoredAt: "ts?",
  } satisfies EntitySpec<Downtime>,

  CustomerOrderLine: {
    id: "id", lineNumber: "int", productId: "id", quantity: "qty", allocatedQuantity: "qty", shippedQuantity: "qty", unitPriceCents: "int",
  } satisfies EntitySpec<CustomerOrderLine>,
  CustomerOrder: {
    id: "id", customerId: "id", createdAt: "ts", dueDate: "ts", status: "enum:CustomerOrderStatus", demandDriver: "str", lines: "@CustomerOrderLine[]",
  } satisfies EntitySpec<CustomerOrder>,
  ShipmentLine: { id: "id", customerOrderLineId: "id", productId: "id", quantity: "qty", fromLocationId: "id" } satisfies EntitySpec<ShipmentLine>,
  Shipment: { id: "id", customerOrderId: "id", customerId: "id", dispatchedAt: "ts", carrier: "str", lines: "@ShipmentLine[]" } satisfies EntitySpec<Shipment>,

  // Containers of the initial-state file.
  MasterData: {
    departments: "@Department[]", locations: "@FactoryLocation[]", suppliers: "@Supplier[]", customers: "@Customer[]", materials: "@Material[]",
    products: "@Product[]", billsOfMaterials: "@BillOfMaterials[]", routings: "@Routing[]", workCenters: "@WorkCenter[]?", workstations: "@Workstation[]",
    equipment: "@Equipment[]?", changeovers: "@ChangeoverRule[]?",
  } satisfies EntitySpec<MasterData>,
  FactoryState: {
    asOf: "ts", lastSequence: "int", inventory: "inventory", inventoryTransactions: "@InventoryTransaction[]", inventoryTransfers: "@InventoryTransfer{}",
    purchaseOrders: "@PurchaseOrder{}", receipts: "@SupplierReceipt{}", productionOrders: "@ProductionOrder{}", productionOperations: "@ProductionOperation{}",
    workstationAssignments: "@WorkstationAssignment{}", qualityInspections: "@QualityInspection{}", workstations: "@WorkstationRuntime{}",
    equipment: "@EquipmentRuntime{}?", downtimes: "@Downtime{}", customerOrders: "@CustomerOrder{}", shipments: "@Shipment{}",
  } satisfies EntitySpec<FactoryState>,
};

// ---------------------------------------------------------------------------
// Event payloads
// ---------------------------------------------------------------------------

const payloads: { [K in EventType]: EntitySpec<EventPayloads[K]> } = {
  PURCHASE_ORDER_CREATED: { purchaseOrder: "@PurchaseOrder" },
  MATERIAL_RECEIVED: { receipt: "@SupplierReceipt" },
  INVENTORY_TRANSFERRED: { transfer: "@InventoryTransfer" },
  CUSTOMER_ORDER_CREATED: { customerOrder: "@CustomerOrder" },
  CUSTOMER_ORDER_CANCELLED: { customerOrderId: "id", reason: "str" },
  PRODUCTION_ORDER_CREATED: { productionOrder: "@ProductionOrder", operations: "@ProductionOperation[]" },
  PRODUCTION_ORDER_RELEASED: { productionOrderId: "id", reservations: "@MaterialReservation[]" },
  PRODUCTION_ORDER_CANCELLED: { productionOrderId: "id", reason: "str" },
  PRODUCTION_BLOCKED: {
    productionOrderId: "id", reason: "enum:BlockReason", shortages: "@MaterialShortage[]?", workstationId: "id?", operationId: "id?", downtimeId: "id?",
  },
  PRODUCTION_RESUMED: { productionOrderId: "id", operationId: "id", workstationId: "id", downtimeId: "id" },
  MATERIAL_CONSUMED: { productionOrderId: "id", consumptions: "@MaterialConsumption[]" },
  PRODUCTION_STARTED: { productionOrderId: "id", workstationId: "id", assignmentId: "id" },
  OPERATION_STARTED: {
    productionOperationId: "id", productionOrderId: "id", workstationId: "id", setupMinutes: "min?", changeoverFromProductId: "id?", equipmentIds: "id[]?",
  },
  OPERATION_COMPLETED: { productionOperationId: "id", productionOrderId: "id", workstationId: "id" },
  PRODUCTION_COMPLETED: { productionOrderId: "id", workstationId: "id", quantityProduced: "qty" },
  QUALITY_INSPECTION_COMPLETED: { inspection: "@QualityInspection" },
  REWORK_REQUESTED: { productionOrderId: "id", inspectionId: "id", quantity: "qty", operations: "@ProductionOperation[]" },
  FINISHED_GOODS_RECEIVED: { productionOrderId: "id", productId: "id", quantity: "qty", locationId: "id" },
  FINISHED_GOODS_ALLOCATED: {
    allocationId: "id", customerOrderId: "id", customerOrderLineId: "id", productId: "id", quantity: "qty", locationId: "id",
  },
  SHIPMENT_DISPATCHED: { shipment: "@Shipment" },
  MACHINE_FAILED: { downtimeId: "id", workstationId: "id", failureCode: "str", expectedRepairMinutes: "min" },
  MACHINE_RESTORED: { downtimeId: "id", workstationId: "id" },
};

/** Entity name used by the codec for an event payload. */
export const payloadEntity = (type: EventType): string => `payload:${type}`;

export const simulationCodec = createCodec(
  {
    ...entities,
    ...Object.fromEntries((Object.keys(payloads) as EventType[]).map((t) => [payloadEntity(t), payloads[t] as Record<string, string>])),
  },
  ENUM_CODES,
);
