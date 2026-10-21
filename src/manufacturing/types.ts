/**
 * Larkhaven Controls – manufacturing domain model.
 *
 * Conventions
 *  - Pure data. No Three.js / DOM dependencies anywhere in src/manufacturing.
 *  - Money:     integer cents (USD).
 *  - Quantity:  integer, in the item's unit of measure (EA = each, KIT = kit, M = metre).
 *  - Duration:  integer minutes.
 *  - Time:      ISO 8601 UTC strings.
 *  - IDs:       stable, human readable (PO-0001, WO-0001, MAT-TB-25, ASM-001 ...).
 *               Location and workstation IDs are identical to the existing 3D
 *               factory object IDs in src/data/factoryLayout.ts.
 */

export const SCHEMA_VERSION = "1.3.0";

export type Id = string;
export type IsoTimestamp = string;
/** Integer US cents. */
export type Cents = number;
/** Integer count in the item's unit of measure. */
export type Quantity = number;
/** Integer minutes. */
export type Minutes = number;

export type UnitOfMeasure = "EA" | "KIT" | "M";

// ---------------------------------------------------------------------------
// Master data
// ---------------------------------------------------------------------------

export type LocationKind = "RECEIVING" | "RAW_STORAGE" | "ASSEMBLY" | "QUALITY" | "SHIPPING";

export interface Department {
  id: Id;
  name: string;
  kind: LocationKind;
}

/** A place where stock or WIP can physically be. `id` == existing 3D object id. */
export interface FactoryLocation {
  id: Id;
  name: string;
  departmentId: Id;
  kind: LocationKind;
  /** Pallet positions available (used to compute utilization from on-hand stock). */
  palletCapacity: number;
}

export interface Supplier {
  id: Id;
  name: string;
  /** Standard lead time from PO creation to promised delivery, calendar days. */
  leadTimeDays: number;
  /** Probability a delivery arrives on the promised date (0..1). */
  onTimeRate: number;
  paymentTermsDays: number;
  receivingLocationId: Id;
}

export interface Customer {
  id: Id;
  name: string;
  region: string;
  paymentTermsDays: number;
}

export interface Material {
  id: Id;
  sku: string;
  description: string;
  uom: UnitOfMeasure;
  standardCostCents: Cents;
  supplierId: Id;
  supplierPartNumber: string;
  leadTimeDays: number;
  /** Where purchased stock is put away (a RAW_STORAGE location). */
  storageLocationId: Id;
  unitsPerPallet: Quantity;
  /** Purchase orders are placed in multiples of this quantity. */
  orderMultiple: Quantity;
  /** Days of expected usage held in the opening balance. */
  initialCoverDays: number;
  /** Extra days of usage the planner keeps as safety stock. */
  safetyDays: number;
}

export interface BomLine {
  materialId: Id;
  /** Quantity of the material per 1 finished unit. */
  quantityPer: Quantity;
}

export interface BillOfMaterials {
  id: Id;
  productId: Id;
  version: string;
  lines: BomLine[];
}

export type OperationType =
  | "MOUNT_AND_WIRE"
  | "MOTOR_CIRCUIT_ASSEMBLY"
  | "PLC_HMI_INTEGRATION"
  | "KIT"
  | "MOUNT"
  | "WIRE"
  | "CONFIGURE"
  | "FINAL_TEST"
  | "REWORK";

export type WorkstationKind = "ASSEMBLY" | "INSPECTION";

export interface RoutingStep {
  sequence: number;
  /** Logical capacity-planning group (design §3.2); the work center whose stations may run this step (schema 1.2.0). */
  workCenterId?: Id;
  operationType: OperationType;
  workstationKind: WorkstationKind;
  /** Standard setup; the applied setup is this unless a `ChangeoverRule` matches (schema 1.3.0). */
  setupMinutes: Minutes;
  minutesPerUnit: Minutes;
  /** Equipment kinds this step needs, one unit of each, held for the whole operation (schema 1.3.0). */
  requiredEquipment?: EquipmentKind[];
}

export interface Routing {
  id: Id;
  productId: Id;
  steps: RoutingStep[];
}

export interface Product {
  id: Id;
  sku: string;
  name: string;
  description: string;
  bomId: Id;
  routingId: Id;
  /** Sum of BOM material standard costs. */
  standardCostCents: Cents;
  listPriceCents: Cents;
  /** Where finished goods of this product are stored. */
  finishedGoodsLocationId: Id;
  unitsPerPallet: Quantity;
  /** Probability a unit fails final test under normal process conditions. */
  baseDefectRate: number;
}

/** Logical capacity-planning group (design §3.2). Stations serve work centers; routing steps require one. */
export interface WorkCenter {
  id: Id;
  name: string;
  kind: WorkstationKind;
}

/** What a piece of equipment is; routing steps require kinds, not individual units (schema 1.3.0). */
export type EquipmentKind = string;

/** A shared tool or machine that operations borrow from a pool; it is not bound to one workstation (schema 1.3.0). */
export interface Equipment {
  id: Id;
  name: string;
  kind: EquipmentKind;
}

/**
 * Setup minutes when `workCenterId` switches from `fromProductId` to `toProductId`
 * (equal ids = repeat run). No matching rule, or a station with no history, means the routing step's standard setup.
 */
export interface ChangeoverRule {
  workCenterId: Id;
  fromProductId: Id;
  toProductId: Id;
  setupMinutes: Minutes;
}

export interface Workstation {
  id: Id;
  name: string;
  kind: WorkstationKind;
  /** Work centers this station can serve; absent in pre-1.2.0 data, where any same-kind station is eligible. */
  workCenterIds?: Id[];
  departmentId: Id;
  locationId: Id;
  /** One job at a time. */
  concurrentJobs: 1;
  /** Duration multiplier; 1.0 = reference speed, >1 slower (from layout capacity). */
  durationFactor: number;
}

export interface MasterData {
  departments: Department[];
  locations: FactoryLocation[];
  suppliers: Supplier[];
  customers: Customer[];
  materials: Material[];
  products: Product[];
  billsOfMaterials: BillOfMaterials[];
  routings: Routing[];
  /** Absent in pre-1.2.0 data. */
  workCenters?: WorkCenter[];
  workstations: Workstation[];
  /** Absent in pre-1.3.0 data (no equipment constraints). */
  equipment?: Equipment[];
  /** Absent in pre-1.3.0 data (setup is always the standard). */
  changeovers?: ChangeoverRule[];
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

export type ItemKind = "RAW_MATERIAL" | "FINISHED_GOOD";

/**
 * Stock of one item at one location.
 *  onHand    – physically present
 *  reserved  – promised to a production order (raw) or customer order line (FG)
 *  available – onHand - reserved (derived, never negative)
 */
export interface InventoryBalance {
  locationId: Id;
  itemId: Id;
  itemKind: ItemKind;
  onHand: Quantity;
  reserved: Quantity;
}

export type InventoryTransactionType =
  | "RECEIPT" //                 +onHand at receiving
  | "TRANSFER_OUT" //            -onHand at source
  | "TRANSFER_IN" //             +onHand at destination
  | "RESERVATION" //             +reserved (raw material for a production order)
  | "RESERVATION_RELEASED" //    -reserved (unused reservation returned)
  | "CONSUMPTION" //             -onHand and -reserved (material becomes WIP)
  | "FG_RECEIPT" //              +onHand (approved finished goods)
  | "FG_ALLOCATION" //           +reserved (FG promised to a customer order line)
  | "FG_ALLOCATION_RELEASED" //  -reserved
  | "SHIPMENT"; //               -onHand and -reserved

export interface InventoryTransaction {
  id: Id;
  eventId: Id;
  timestamp: IsoTimestamp;
  type: InventoryTransactionType;
  itemId: Id;
  itemKind: ItemKind;
  locationId: Id;
  onHandDelta: Quantity;
  reservedDelta: Quantity;
  referenceType: "PURCHASE_ORDER" | "TRANSFER" | "PRODUCTION_ORDER" | "CUSTOMER_ORDER" | "SHIPMENT";
  referenceId: Id;
}

export type TransferReason = "PUTAWAY";

export interface InventoryTransfer {
  id: Id;
  itemId: Id;
  itemKind: ItemKind;
  quantity: Quantity;
  fromLocationId: Id;
  toLocationId: Id;
  reason: TransferReason;
}

// ---------------------------------------------------------------------------
// Purchasing
// ---------------------------------------------------------------------------

export type PurchaseOrderStatus = "OPEN" | "PARTIALLY_RECEIVED" | "RECEIVED";

export interface PurchaseOrderLine {
  id: Id;
  lineNumber: number;
  materialId: Id;
  orderedQuantity: Quantity;
  receivedQuantity: Quantity;
  unitCostCents: Cents;
}

export interface PurchaseOrder {
  id: Id;
  supplierId: Id;
  createdAt: IsoTimestamp;
  promisedDeliveryAt: IsoTimestamp;
  receivingLocationId: Id;
  status: PurchaseOrderStatus;
  /** Why the planner raised it (traceability). */
  reason: "REORDER_POINT";
  lines: PurchaseOrderLine[];
  totalCents: Cents;
}

export type DelayReason = "CARRIER_DELAY" | "SUPPLIER_STOCKOUT" | "CUSTOMS_HOLD";

export interface SupplierReceiptLine {
  id: Id;
  purchaseOrderLineId: Id;
  materialId: Id;
  quantity: Quantity;
}

export interface SupplierReceipt {
  id: Id;
  purchaseOrderId: Id;
  supplierId: Id;
  receivedAt: IsoTimestamp;
  locationId: Id;
  lines: SupplierReceiptLine[];
  /** Calendar days after the PO's promised date (0 = on time). */
  daysLate: number;
  delayReason?: DelayReason;
  /** True when the supplier shipped less than the outstanding PO quantity. */
  shortShipment: boolean;
}

// ---------------------------------------------------------------------------
// Manufacturing
// ---------------------------------------------------------------------------

/**
 * PLANNED   created, materials not yet reserved
 * WAITING   released: materials reserved, queued for a workstation
 * RUNNING   in process (assembly, rework or QC)
 * BLOCKED   cannot progress (material shortage before release, or machine down)
 * COMPLETED finished goods received (or order closed with zero yield)
 * CANCELLED demand disappeared before materials were consumed
 */
export type ProductionOrderStatus = "PLANNED" | "WAITING" | "RUNNING" | "BLOCKED" | "COMPLETED" | "CANCELLED";

export type ProductionStage =
  | "PLANNING"
  | "QUEUED"
  | "ASSEMBLY"
  | "AWAITING_QC"
  | "QUALITY"
  | "REWORK"
  | "FINISHED"
  | "CANCELLED";

export type BlockReason = "MATERIAL_SHORTAGE" | "MACHINE_DOWN";

export interface MaterialReservation {
  materialId: Id;
  quantity: Quantity;
  locationId: Id;
}

export interface MaterialShortage {
  materialId: Id;
  required: Quantity;
  available: Quantity;
  /** Open purchase orders that will cover the gap (traceability). */
  expectedPurchaseOrderIds: Id[];
}

export interface MaterialConsumption {
  materialId: Id;
  quantity: Quantity;
  fromLocationId: Id;
  /** Workstation location the material is issued to – it is WIP from here on. */
  toLocationId: Id;
}

export interface ProductionOrder {
  id: Id;
  productId: Id;
  /** Units to build (good units targeted, includes yield allowance). */
  quantity: Quantity;
  status: ProductionOrderStatus;
  stage: ProductionStage;
  createdAt: IsoTimestamp;
  dueDate: IsoTimestamp;
  /** Customer order lines this order was planned to satisfy. */
  demandLineIds: Id[];
  releasedAt?: IsoTimestamp;
  startedAt?: IsoTimestamp;
  productionCompletedAt?: IsoTimestamp;
  completedAt?: IsoTimestamp;
  assignedWorkstationId?: Id;
  /** Where the WIP currently physically sits. */
  currentLocationId?: Id;
  reservations: MaterialReservation[];
  materialsConsumed: boolean;
  blockReason?: BlockReason;
  blockedAt?: IsoTimestamp;
  operationIds: Id[];
  inspectionIds: Id[];
  /** Units that are WIP (consumed, not yet in finished goods or scrapped). */
  wipQuantity: Quantity;
  awaitingQcQuantity: Quantity;
  reworkPendingQuantity: Quantity;
  approvedQuantity: Quantity;
  scrappedQuantity: Quantity;
  finishedGoodsReceivedQuantity: Quantity;
}

export type OperationStatus = "PENDING" | "RUNNING" | "PAUSED" | "COMPLETED";

export interface ProductionOperation {
  id: Id;
  productionOrderId: Id;
  sequence: number;
  type: OperationType;
  workstationKind: WorkstationKind;
  /** Logical work center copied from the routing step (rework: WC-WIRING); absent in pre-1.1.0 data. */
  workCenterId?: Id;
  /** Units processed by this operation. */
  quantity: Quantity;
  plannedMinutes: Minutes;
  /** Standard setup included in `plannedMinutes` (schema 1.3.0). */
  standardSetupMinutes?: Minutes;
  /** Equipment kinds required, copied from the routing step (schema 1.3.0). */
  requiredEquipment?: EquipmentKind[];
  isRework: boolean;
  status: OperationStatus;
  workstationId?: Id;
  /** Setup actually applied at start (schema 1.3.0). */
  setupMinutes?: Minutes;
  /** Product this station last ran for the operation's work center, when different from this order's product (schema 1.3.0). */
  changeoverFromProductId?: Id;
  /** Equipment held from start to completion (schema 1.3.0). */
  equipmentIds?: Id[];
  startedAt?: IsoTimestamp;
  completedAt?: IsoTimestamp;
  pausedAt?: IsoTimestamp;
  /** Minutes the operation spent paused by machine failures. */
  pausedMinutes: Minutes;
  interruptedByDowntimeIds: Id[];
}

export interface WorkstationAssignment {
  id: Id;
  productionOrderId: Id;
  workstationId: Id;
  assignedAt: IsoTimestamp;
  releasedAt?: IsoTimestamp;
}

export type DefectCode = "WIRING_ERROR" | "LOOSE_TERMINATION" | "FUNCTIONAL_TEST_FAIL" | "ENCLOSURE_DAMAGE";

export interface DefectCount {
  code: DefectCode;
  quantity: Quantity;
}

export interface QualityInspection {
  id: Id;
  productionOrderId: Id;
  operationId: Id;
  workstationId: Id;
  /** 1 = first pass, 2 = re-inspection after rework. */
  round: number;
  inspectedAt: IsoTimestamp;
  inspectedQuantity: Quantity;
  passedQuantity: Quantity;
  failedQuantity: Quantity;
  reworkQuantity: Quantity;
  scrapQuantity: Quantity;
  defects: DefectCount[];
  /** Why units failed (traceable to an upstream event). */
  cause?: { kind: "PROCESS_VARIATION" | "MACHINE_FAILURE"; downtimeId?: Id };
}

export type WorkstationRunStatus = "IDLE" | "RUNNING" | "DOWN";

export interface WorkstationRuntime {
  workstationId: Id;
  status: WorkstationRunStatus;
  currentOperationId?: Id;
  /** Operation interrupted by a failure; resumes when the machine is restored. */
  pausedOperationId?: Id;
  /** Product of the last non-rework operation started here, per work center; drives changeover (schema 1.3.0). */
  lastProductByWorkCenter?: Record<Id, Id>;
  since: IsoTimestamp;
}

/** Which operation holds a piece of equipment right now (schema 1.3.0). */
export interface EquipmentRuntime {
  equipmentId: Id;
  currentOperationId?: Id;
}

export interface Downtime {
  id: Id;
  workstationId: Id;
  failureCode: string;
  failedAt: IsoTimestamp;
  expectedRepairMinutes: Minutes;
  restoredAt?: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// Sales & logistics
// ---------------------------------------------------------------------------

export type CustomerOrderStatus = "OPEN" | "PARTIALLY_SHIPPED" | "SHIPPED" | "CANCELLED";
export type DemandDriver = "BASELINE" | "SURGE_CAMPAIGN";

export interface CustomerOrderLine {
  id: Id;
  lineNumber: number;
  productId: Id;
  quantity: Quantity;
  /** Finished goods reserved for this line and not yet shipped. */
  allocatedQuantity: Quantity;
  shippedQuantity: Quantity;
  unitPriceCents: Cents;
}

export interface CustomerOrder {
  id: Id;
  customerId: Id;
  createdAt: IsoTimestamp;
  dueDate: IsoTimestamp;
  status: CustomerOrderStatus;
  demandDriver: DemandDriver;
  lines: CustomerOrderLine[];
}

export interface ShipmentLine {
  id: Id;
  customerOrderLineId: Id;
  productId: Id;
  quantity: Quantity;
  fromLocationId: Id;
}

export interface Shipment {
  id: Id;
  customerOrderId: Id;
  customerId: Id;
  dispatchedAt: IsoTimestamp;
  carrier: string;
  lines: ShipmentLine[];
}

// ---------------------------------------------------------------------------
// Factory state (the thing events are replayed onto)
// ---------------------------------------------------------------------------

export interface FactoryState {
  /** Timestamp of the last applied event (or the simulation start). */
  asOf: IsoTimestamp;
  /** Sequence of the last applied event; 0 for the initial state. */
  lastSequence: number;
  /** Keyed by `${locationId}::${itemId}`. */
  inventory: Record<string, InventoryBalance>;
  inventoryTransactions: InventoryTransaction[];
  inventoryTransfers: Record<Id, InventoryTransfer>;
  purchaseOrders: Record<Id, PurchaseOrder>;
  receipts: Record<Id, SupplierReceipt>;
  productionOrders: Record<Id, ProductionOrder>;
  productionOperations: Record<Id, ProductionOperation>;
  workstationAssignments: Record<Id, WorkstationAssignment>;
  qualityInspections: Record<Id, QualityInspection>;
  workstations: Record<Id, WorkstationRuntime>;
  /** Absent in pre-1.3.0 data. */
  equipment?: Record<Id, EquipmentRuntime>;
  downtimes: Record<Id, Downtime>;
  customerOrders: Record<Id, CustomerOrder>;
  shipments: Record<Id, Shipment>;
}

/** Authoritative replay source: master data + state at t0. */
export interface InitialStateFile {
  schemaVersion: string;
  master: MasterData;
  state: FactoryState;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface EventPayloads {
  PURCHASE_ORDER_CREATED: { purchaseOrder: PurchaseOrder };
  MATERIAL_RECEIVED: { receipt: SupplierReceipt };
  INVENTORY_TRANSFERRED: { transfer: InventoryTransfer };
  CUSTOMER_ORDER_CREATED: { customerOrder: CustomerOrder };
  CUSTOMER_ORDER_CANCELLED: { customerOrderId: Id; reason: "CUSTOMER_REQUEST" };
  PRODUCTION_ORDER_CREATED: { productionOrder: ProductionOrder; operations: ProductionOperation[] };
  PRODUCTION_ORDER_RELEASED: { productionOrderId: Id; reservations: MaterialReservation[] };
  PRODUCTION_ORDER_CANCELLED: { productionOrderId: Id; reason: "DEMAND_CANCELLED" };
  PRODUCTION_BLOCKED: {
    productionOrderId: Id;
    reason: BlockReason;
    shortages?: MaterialShortage[];
    workstationId?: Id;
    operationId?: Id;
    downtimeId?: Id;
  };
  PRODUCTION_RESUMED: { productionOrderId: Id; operationId: Id; workstationId: Id; downtimeId: Id };
  MATERIAL_CONSUMED: { productionOrderId: Id; consumptions: MaterialConsumption[] };
  PRODUCTION_STARTED: { productionOrderId: Id; workstationId: Id; assignmentId: Id };
  OPERATION_STARTED: {
    productionOperationId: Id;
    productionOrderId: Id;
    workstationId: Id;
    /** Setup applied (schema 1.3.0); absent = the operation's standard setup. */
    setupMinutes?: Minutes;
    /** Set when the station last ran a different product for this work center. */
    changeoverFromProductId?: Id;
    /** One unit per required kind (schema 1.3.0). */
    equipmentIds?: Id[];
  };
  OPERATION_COMPLETED: { productionOperationId: Id; productionOrderId: Id; workstationId: Id };
  PRODUCTION_COMPLETED: { productionOrderId: Id; workstationId: Id; quantityProduced: Quantity };
  QUALITY_INSPECTION_COMPLETED: { inspection: QualityInspection };
  REWORK_REQUESTED: { productionOrderId: Id; inspectionId: Id; quantity: Quantity; operations: ProductionOperation[] };
  FINISHED_GOODS_RECEIVED: { productionOrderId: Id; productId: Id; quantity: Quantity; locationId: Id };
  FINISHED_GOODS_ALLOCATED: {
    allocationId: Id;
    customerOrderId: Id;
    customerOrderLineId: Id;
    productId: Id;
    quantity: Quantity;
    locationId: Id;
  };
  SHIPMENT_DISPATCHED: { shipment: Shipment };
  MACHINE_FAILED: { downtimeId: Id; workstationId: Id; failureCode: string; expectedRepairMinutes: Minutes };
  MACHINE_RESTORED: { downtimeId: Id; workstationId: Id };
}

export type EventType = keyof EventPayloads;

/** Entity IDs touched by an event, derived from the payload (see events.ts). */
export interface EventEntityRefs {
  purchaseOrderId?: Id;
  supplierId?: Id;
  materialIds?: Id[];
  productId?: Id;
  productionOrderId?: Id;
  productionOperationId?: Id;
  workstationId?: Id;
  customerId?: Id;
  customerOrderId?: Id;
  shipmentId?: Id;
  inspectionId?: Id;
  downtimeId?: Id;
  locationIds?: Id[];
}

export interface EventEnvelope<T extends EventType, P> {
  /** Unique, derived from the sequence number: EVT-000123. */
  id: Id;
  /** Global, strictly increasing. Orders events that share a timestamp. */
  sequence: number;
  timestamp: IsoTimestamp;
  type: T;
  entities: EventEntityRefs;
  payload: P;
}

export type FactoryEvent<T extends EventType = EventType> = {
  [K in T]: EventEnvelope<K, EventPayloads[K]>;
}[T];

// ---------------------------------------------------------------------------
// Dataset + manifest
// ---------------------------------------------------------------------------

export interface GeneratorConfig {
  seed: string | number;
  /** Simulation start (ISO, UTC). */
  startDate: IsoTimestamp;
  days: number;
  /** Exact number of customer orders created over the period. */
  customerOrders: number;
  /** Target number of purchase orders (sets the supplier review cycle; actual count varies). */
  purchaseOrders: number;
  /** Customers drawn from the pool of 10. */
  customerCount: number;
  /** 1..N, N = assembly stations in the factory layout (ASM-001..). */
  assemblyWorkstations: number;
  /** 1..N, N = inspection cells in the factory layout (QC-001..). */
  inspectionWorkstations: number;
  /** Opening finished-goods units per product. */
  openingFinishedGoodsUnits: number;
  /** Smallest production lot. */
  minProductionLot: number;
  machineFailuresPerWorkstation: number;
  demandSurge: { startDay: number; endDay: number; multiplier: number } | null;
}

export interface Manifest {
  schemaVersion: string;
  seed: string | number;
  config: GeneratorConfig;
  simulatedRange: { start: IsoTimestamp; end: IsoTimestamp };
  eventCount: number;
  eventTypeCounts: Record<string, number>;
  /** FNV-1a hash of the serialized event log; identical for identical seed + config. */
  eventLogHash: string;
  recordCounts: Record<string, number>;
}

export interface ManufacturingDataset {
  manifest: Manifest;
  master: MasterData;
  initialState: FactoryState;
  events: FactoryEvent[];
  finalState: FactoryState;
}
