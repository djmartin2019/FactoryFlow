import { factoryLayout } from "../data/factoryLayout.ts";
import type {
  BillOfMaterials,
  Customer,
  Department,
  FactoryLocation,
  GeneratorConfig,
  LocationKind,
  MasterData,
  Material,
  Product,
  Routing,
  Supplier,
  Workstation,
} from "./types.ts";

export const DEFAULT_CONFIG: GeneratorConfig = {
  seed: "northstar-2026",
  startDate: "2026-09-01T00:00:00.000Z",
  days: 30,
  // Calibrated for the 6-assembly / 3-QC facility: 180 orders lifts average
  // assembly utilization from ~54% (75 orders on 3 stations) to ~60% with
  // every station working. 75 purchasing reviews = a daily review cycle.
  customerOrders: 180,
  purchaseOrders: 75,
  customerCount: 10,
  assemblyWorkstations: 6,
  inspectionWorkstations: 3,
  openingFinishedGoodsUnits: 3,
  minProductionLot: 2,
  machineFailuresPerWorkstation: 2,
  demandSurge: { startDay: 12, endDay: 16, multiplier: 2.5 },
};

export function resolveConfig(overrides: Partial<GeneratorConfig> = {}): GeneratorConfig {
  const config = { ...DEFAULT_CONFIG, ...overrides };
  const check = (ok: boolean, msg: string) => {
    if (!ok) throw new Error(`Invalid generator config: ${msg}`);
  };
  check(Number.isInteger(config.days) && config.days >= 7, "days must be an integer >= 7");
  check(Number.isInteger(config.customerOrders) && config.customerOrders >= 1, "customerOrders must be >= 1");
  check(config.customerCount >= 1 && config.customerCount <= 10, "customerCount must be 1..10");
  check(Number.isInteger(config.assemblyWorkstations) && config.assemblyWorkstations >= 1 && config.assemblyWorkstations <= ASSEMBLY_CAPACITY, `assemblyWorkstations must be 1..${ASSEMBLY_CAPACITY}`);
  check(Number.isInteger(config.inspectionWorkstations) && config.inspectionWorkstations >= 1 && config.inspectionWorkstations <= INSPECTION_CAPACITY, `inspectionWorkstations must be 1..${INSPECTION_CAPACITY}`);
  check(config.purchaseOrders >= 1, "purchaseOrders must be >= 1");
  check(!Number.isNaN(Date.parse(config.startDate)), "startDate must be an ISO timestamp");
  return config;
}

/** Reference assembly throughput (layout capacity of ASM-001) for duration factors. */
const REFERENCE_CAPACITY = 120;

const DEPARTMENTS: Department[] = [
  { id: "DEPT-RECEIVING", name: "Receiving", kind: "RECEIVING" },
  { id: "DEPT-RAW-INVENTORY", name: "Raw Inventory", kind: "RAW_STORAGE" },
  { id: "DEPT-ASSEMBLY", name: "Assembly", kind: "ASSEMBLY" },
  { id: "DEPT-QUALITY", name: "Quality Control", kind: "QUALITY" },
  { id: "DEPT-SHIPPING", name: "Shipping", kind: "SHIPPING" },
];

const PALLET_CAPACITY: Record<LocationKind, number> = {
  RECEIVING: 6,
  RAW_STORAGE: 24,
  ASSEMBLY: 4,
  QUALITY: 4,
  SHIPPING: 16,
};

function kindFromObjectId(id: string): LocationKind {
  const prefix = id.split("-")[0];
  switch (prefix) {
    case "REC": return "RECEIVING";
    case "INV": return "RAW_STORAGE";
    case "ASM": return "ASSEMBLY";
    case "QC": return "QUALITY";
    case "SHP": return "SHIPPING";
    default: throw new Error(`Unrecognised factory object id: ${id}`);
  }
}

/** Workstation counts are bounded by the stations the factory layout provides. */
const layoutCount = (kind: LocationKind) => factoryLayout.filter((o) => kindFromObjectId(o.id) === kind).length;
const ASSEMBLY_CAPACITY = layoutCount("ASSEMBLY");
const INSPECTION_CAPACITY = layoutCount("QUALITY");

const SUPPLIERS: Supplier[] = [
  { id: "SUP-001", name: "Ironbridge Metalworks", leadTimeDays: 5, onTimeRate: 0.9, paymentTermsDays: 30, receivingLocationId: "REC-001" },
  { id: "SUP-002", name: "Voltaic Switchgear Ltd", leadTimeDays: 7, onTimeRate: 0.85, paymentTermsDays: 45, receivingLocationId: "REC-002" },
  { id: "SUP-003", name: "Clearline Connectors", leadTimeDays: 4, onTimeRate: 0.92, paymentTermsDays: 30, receivingLocationId: "REC-003" },
  { id: "SUP-004", name: "Meridian Automation Supply", leadTimeDays: 12, onTimeRate: 0.65, paymentTermsDays: 60, receivingLocationId: "REC-002" },
  { id: "SUP-005", name: "Brightwater Power Systems", leadTimeDays: 8, onTimeRate: 0.8, paymentTermsDays: 45, receivingLocationId: "REC-003" },
];

const CUSTOMERS: Customer[] = [
  { id: "CUS-001", name: "Alder Valley Packaging", region: "Midwest", paymentTermsDays: 30 },
  { id: "CUS-002", name: "Birchwood Water Utilities", region: "Northeast", paymentTermsDays: 45 },
  { id: "CUS-003", name: "Cobalt Ridge Mining", region: "Mountain West", paymentTermsDays: 30 },
  { id: "CUS-004", name: "Dunmore Food Processing", region: "Southeast", paymentTermsDays: 30 },
  { id: "CUS-005", name: "Eastgate Logistics", region: "Mid-Atlantic", paymentTermsDays: 15 },
  { id: "CUS-006", name: "Fernhill HVAC Systems", region: "Southwest", paymentTermsDays: 30 },
  { id: "CUS-007", name: "Granite Peak Plastics", region: "Midwest", paymentTermsDays: 45 },
  { id: "CUS-008", name: "Harborline Cold Storage", region: "Pacific", paymentTermsDays: 30 },
  { id: "CUS-009", name: "Ironwood Textile Mills", region: "Southeast", paymentTermsDays: 60 },
  { id: "CUS-010", name: "Juniper Bay Pumps", region: "Gulf Coast", paymentTermsDays: 30 },
];

type MaterialSeed = Omit<Material, "sku" | "supplierPartNumber" | "leadTimeDays"> & { partNumber: string };

const MATERIALS: MaterialSeed[] = [
  { id: "MAT-ENC-S", description: "Steel enclosure 600x400x200 mm, IP54", uom: "EA", standardCostCents: 8450, supplierId: "SUP-001", partNumber: "IM-E640", storageLocationId: "INV-001", unitsPerPallet: 20, orderMultiple: 10, initialCoverDays: 8, safetyDays: 3 },
  { id: "MAT-ENC-M", description: "Steel enclosure 800x600x250 mm, IP54", uom: "EA", standardCostCents: 14900, supplierId: "SUP-001", partNumber: "IM-E862", storageLocationId: "INV-001", unitsPerPallet: 12, orderMultiple: 10, initialCoverDays: 8, safetyDays: 3 },
  { id: "MAT-ENC-L", description: "Steel enclosure 1000x800x300 mm, IP55", uom: "EA", standardCostCents: 26800, supplierId: "SUP-001", partNumber: "IM-E1083", storageLocationId: "INV-001", unitsPerPallet: 8, orderMultiple: 5, initialCoverDays: 8, safetyDays: 3 },
  { id: "MAT-DIN-35", description: "DIN rail 35 mm, sold per metre", uom: "M", standardCostCents: 385, supplierId: "SUP-001", partNumber: "IM-D35", storageLocationId: "INV-001", unitsPerPallet: 500, orderMultiple: 50, initialCoverDays: 10, safetyDays: 3 },
  { id: "MAT-BRK-1P", description: "Circuit breaker 1-pole 16 A", uom: "EA", standardCostCents: 1850, supplierId: "SUP-002", partNumber: "VS-B116", storageLocationId: "INV-002", unitsPerPallet: 400, orderMultiple: 50, initialCoverDays: 8, safetyDays: 3 },
  { id: "MAT-BRK-3P", description: "Circuit breaker 3-pole 32 A", uom: "EA", standardCostCents: 6400, supplierId: "SUP-002", partNumber: "VS-B332", storageLocationId: "INV-002", unitsPerPallet: 200, orderMultiple: 25, initialCoverDays: 8, safetyDays: 3 },
  { id: "MAT-RLY-24", description: "Control relay 24 VDC, 4-pole", uom: "EA", standardCostCents: 1650, supplierId: "SUP-002", partNumber: "VS-R424", storageLocationId: "INV-002", unitsPerPallet: 500, orderMultiple: 50, initialCoverDays: 8, safetyDays: 3 },
  { id: "MAT-CTR-25", description: "Contactor 25 A, 24 VDC coil", uom: "EA", standardCostCents: 5250, supplierId: "SUP-002", partNumber: "VS-C25", storageLocationId: "INV-002", unitsPerPallet: 150, orderMultiple: 20, initialCoverDays: 8, safetyDays: 3 },
  { id: "MAT-TB-25", description: "Terminal block 2.5 mm2, DIN mount", uom: "EA", standardCostCents: 215, supplierId: "SUP-003", partNumber: "CL-T25", storageLocationId: "INV-003", unitsPerPallet: 5000, orderMultiple: 500, initialCoverDays: 9, safetyDays: 3 },
  { id: "MAT-WIRE-KIT", description: "Panel wiring kit (cable, ferrules, duct)", uom: "KIT", standardCostCents: 5900, supplierId: "SUP-003", partNumber: "CL-WK1", storageLocationId: "INV-003", unitsPerPallet: 100, orderMultiple: 20, initialCoverDays: 9, safetyDays: 3 },
  { id: "MAT-PLC-CPU", description: "PLC CPU module, 16 DI / 16 DO", uom: "EA", standardCostCents: 38500, supplierId: "SUP-004", partNumber: "MA-PLC16", storageLocationId: "INV-004", unitsPerPallet: 60, orderMultiple: 5, initialCoverDays: 6, safetyDays: 2 },
  { id: "MAT-HMI-7", description: "7-inch touchscreen HMI display", uom: "EA", standardCostCents: 29900, supplierId: "SUP-004", partNumber: "MA-HMI7", storageLocationId: "INV-004", unitsPerPallet: 40, orderMultiple: 5, initialCoverDays: 6, safetyDays: 2 },
  { id: "MAT-PSU-24", description: "Power supply 24 VDC 10 A", uom: "EA", standardCostCents: 7600, supplierId: "SUP-005", partNumber: "BW-P2410", storageLocationId: "INV-003", unitsPerPallet: 120, orderMultiple: 10, initialCoverDays: 9, safetyDays: 3 },
];

const BOMS: Record<string, Array<[string, number]>> = {
  "NCP-100": [
    ["MAT-ENC-S", 1], ["MAT-BRK-1P", 2], ["MAT-BRK-3P", 1], ["MAT-TB-25", 12],
    ["MAT-DIN-35", 1], ["MAT-WIRE-KIT", 1], ["MAT-RLY-24", 2], ["MAT-PSU-24", 1],
  ],
  "NCP-200": [
    ["MAT-ENC-M", 1], ["MAT-BRK-3P", 2], ["MAT-BRK-1P", 1], ["MAT-TB-25", 18],
    ["MAT-DIN-35", 2], ["MAT-WIRE-KIT", 1], ["MAT-RLY-24", 3], ["MAT-CTR-25", 2], ["MAT-PSU-24", 1],
  ],
  "NCP-300": [
    ["MAT-ENC-L", 1], ["MAT-BRK-3P", 2], ["MAT-BRK-1P", 2], ["MAT-TB-25", 30],
    ["MAT-DIN-35", 3], ["MAT-WIRE-KIT", 2], ["MAT-RLY-24", 4], ["MAT-CTR-25", 2],
    ["MAT-PLC-CPU", 1], ["MAT-HMI-7", 1], ["MAT-PSU-24", 2],
  ],
};

const PRODUCT_SEEDS = [
  { id: "NCP-100", name: "Basic Control Panel", description: "Entry-level relay-logic control panel", listPriceCents: 95000, fgLocation: "SHP-001", unitsPerPallet: 6, baseDefectRate: 0.02 },
  { id: "NCP-200", name: "Motor Control Panel", description: "Contactor-based motor starter panel", listPriceCents: 189000, fgLocation: "SHP-002", unitsPerPallet: 4, baseDefectRate: 0.04 },
  { id: "NCP-300", name: "Advanced Automation Panel", description: "PLC and HMI based automation panel", listPriceCents: 465000, fgLocation: "SHP-003", unitsPerPallet: 2, baseDefectRate: 0.07 },
];

/** Product mix used by demand generation and cover planning. */
export const PRODUCT_MIX: Record<string, number> = { "NCP-100": 0.5, "NCP-200": 0.3, "NCP-300": 0.2 };

const ROUTING_STEPS: Record<string, Routing["steps"]> = {
  "NCP-100": [
    { sequence: 10, operationType: "MOUNT_AND_WIRE", workstationKind: "ASSEMBLY", setupMinutes: 20, minutesPerUnit: 25 },
    { sequence: 20, operationType: "FINAL_TEST", workstationKind: "INSPECTION", setupMinutes: 10, minutesPerUnit: 8 },
  ],
  "NCP-200": [
    { sequence: 10, operationType: "MOUNT_AND_WIRE", workstationKind: "ASSEMBLY", setupMinutes: 20, minutesPerUnit: 30 },
    { sequence: 20, operationType: "MOTOR_CIRCUIT_ASSEMBLY", workstationKind: "ASSEMBLY", setupMinutes: 15, minutesPerUnit: 20 },
    { sequence: 30, operationType: "FINAL_TEST", workstationKind: "INSPECTION", setupMinutes: 10, minutesPerUnit: 12 },
  ],
  "NCP-300": [
    { sequence: 10, operationType: "MOUNT_AND_WIRE", workstationKind: "ASSEMBLY", setupMinutes: 25, minutesPerUnit: 40 },
    { sequence: 20, operationType: "PLC_HMI_INTEGRATION", workstationKind: "ASSEMBLY", setupMinutes: 30, minutesPerUnit: 35 },
    { sequence: 30, operationType: "FINAL_TEST", workstationKind: "INSPECTION", setupMinutes: 15, minutesPerUnit: 20 },
  ],
};

/** Minutes for the rework step, per unit. */
export const REWORK_MINUTES_PER_UNIT = 25;
export const REWORK_SETUP_MINUTES = 10;

export function buildMasterData(config: GeneratorConfig): MasterData {
  const departmentOfKind = new Map(DEPARTMENTS.map((d) => [d.kind, d.id]));

  const locations: FactoryLocation[] = factoryLayout.map((obj) => {
    const kind = kindFromObjectId(obj.id);
    return {
      id: obj.id,
      name: obj.name ?? obj.id,
      departmentId: departmentOfKind.get(kind)!,
      kind,
      palletCapacity: PALLET_CAPACITY[kind],
    };
  });
  const layoutCapacity = new Map(factoryLayout.map((o) => [o.id, o.capacity ?? REFERENCE_CAPACITY]));

  const workstations: Workstation[] = [];
  for (let i = 1; i <= config.assemblyWorkstations; i++) {
    const id = `ASM-${String(i).padStart(3, "0")}`;
    const loc = locations.find((l) => l.id === id);
    if (!loc) throw new Error(`Layout has no ${id}`);
    workstations.push({
      id,
      name: loc.name,
      kind: "ASSEMBLY",
      departmentId: loc.departmentId,
      locationId: id,
      concurrentJobs: 1,
      durationFactor: Math.round((REFERENCE_CAPACITY / (layoutCapacity.get(id) ?? REFERENCE_CAPACITY)) * 100) / 100,
    });
  }
  for (let i = 1; i <= config.inspectionWorkstations; i++) {
    const id = `QC-${String(i).padStart(3, "0")}`;
    const loc = locations.find((l) => l.id === id);
    if (!loc) throw new Error(`Layout has no ${id}`);
    workstations.push({
      id, name: loc.name, kind: "INSPECTION", departmentId: loc.departmentId, locationId: id, concurrentJobs: 1, durationFactor: 1,
    });
  }

  const materials: Material[] = MATERIALS.map(({ partNumber, ...m }) => {
    const supplier = SUPPLIERS.find((s) => s.id === m.supplierId)!;
    return { ...m, sku: m.id, supplierPartNumber: partNumber, leadTimeDays: supplier.leadTimeDays };
  });

  const billsOfMaterials: BillOfMaterials[] = Object.entries(BOMS).map(([productId, lines]) => ({
    id: `BOM-${productId}`,
    productId,
    version: "A",
    lines: lines.map(([materialId, quantityPer]) => ({ materialId, quantityPer })),
  }));

  const costOf = new Map(materials.map((m) => [m.id, m.standardCostCents]));
  const products: Product[] = PRODUCT_SEEDS.map((p) => ({
    id: p.id,
    sku: p.id,
    name: p.name,
    description: p.description,
    bomId: `BOM-${p.id}`,
    routingId: `RTG-${p.id}`,
    standardCostCents: BOMS[p.id].reduce((sum, [mat, qty]) => sum + costOf.get(mat)! * qty, 0),
    listPriceCents: p.listPriceCents,
    finishedGoodsLocationId: p.fgLocation,
    unitsPerPallet: p.unitsPerPallet,
    baseDefectRate: p.baseDefectRate,
  }));

  const routings: Routing[] = PRODUCT_SEEDS.map((p) => ({
    id: `RTG-${p.id}`,
    productId: p.id,
    steps: ROUTING_STEPS[p.id],
  }));

  return {
    departments: DEPARTMENTS,
    locations,
    suppliers: SUPPLIERS,
    customers: CUSTOMERS.slice(0, config.customerCount),
    materials,
    products,
    billsOfMaterials,
    routings,
    workstations,
  };
}
