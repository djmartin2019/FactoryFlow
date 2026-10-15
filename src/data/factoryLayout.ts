import type { FactoryObjectConfig } from "../graphics/FactoryObject";
import type {
  BuildingConfig,
  DepartmentConfig,
  DockDoorConfig,
  FloorMarkingsConfig,
} from "./layoutTypes";

/**
 * Coordinate system: 1 world unit = 1 metre. The floor is the y = 0 plane,
 * +x runs east (left to right on screen), +z runs south (towards the default
 * camera), +y is up. The building is centred on the origin (80 x 44 m).
 *
 *   north wall (z = -22)
 *   +--------------------------------------------------------------------+
 *   | INVENTORY (2x2)  | ASSEMBLY (2 rows x 3)        | QUALITY (3 cells) |
 *   |                  |                              |                   |
 *   |===== main material-handling aisle (z -2..2) =======================|
 *   | RECEIVING (3)    |  (open yard, future use)     | SHIPPING (3)      |
 *   +--------------------------------------------------------------------+
 *   west wall (x=-40)                                  east wall (x=40)
 *
 * Flow is a U: dock in (west) -> inventory -> assembly -> quality -> ship
 * out (east). Receiving and shipping sit on the west/east exterior walls.
 * Stations are data: add an entry here (and a station id the manufacturing
 * model knows) and everything else - master data, selection, dashboard -
 * picks it up from the id.
 */
export const building: BuildingConfig = {
  bounds: { minX: -40, maxX: 40, minZ: -22, maxZ: 22 },
  wallHeight: 8,
  wallThickness: 0.6,
};

export const departments: DepartmentConfig[] = [
  { id: "receiving", name: "Receiving", color: 0x3f6fb5,
    bounds: { minX: -38, maxX: -24, minZ: 3, maxZ: 20.5 } },
  { id: "inventory", name: "Raw Material Inventory", color: 0x7a5fb0,
    bounds: { minX: -38, maxX: -20, minZ: -20, maxZ: -4 } },
  { id: "assembly", name: "Assembly", color: 0x2f9a93,
    bounds: { minX: -16, maxX: 8, minZ: -20, maxZ: -4 } },
  { id: "quality", name: "Quality Control", color: 0xb08a3e,
    bounds: { minX: 12, maxX: 36, minZ: -20, maxZ: -4 } },
  { id: "shipping", name: "Shipping", color: 0x55a066,
    bounds: { minX: 24, maxX: 38, minZ: 3, maxZ: 20.5 } },
];

/** Dock doors line up with the staging pads (z = 6, 11.2 and 16.4). */
export const dockDoors: DockDoorConfig[] = [
  { wall: "west", z: 6, width: 3, department: "receiving" },
  { wall: "west", z: 11.2, width: 3, department: "receiving" },
  { wall: "west", z: 16.4, width: 3, department: "receiving" },
  { wall: "east", z: 6, width: 3, department: "shipping" },
  { wall: "east", z: 11.2, width: 3, department: "shipping" },
  { wall: "east", z: 16.4, width: 3, department: "shipping" },
];

export const floorMarkings: FloorMarkingsConfig = {
  // 4 m main aisle (z -2..2), the 4 m cross aisle between inventory and
  // assembly (x -20..-16) and a 4 m aisle between the two assembly rows.
  aisles: [
    { minX: -38, maxX: 38, minZ: -2, maxZ: 2 },
    { minX: -20, maxX: -16, minZ: -20, maxZ: -2 },
    { minX: -16, maxX: 8, minZ: -15.5, maxZ: -11.5 },
  ],
  // 1.5 m pedestrian walkways in the 4 m gaps beside assembly / shipping.
  walkways: [
    { minX: 9.25, maxX: 10.75, minZ: -20, maxZ: -4 },
    { minX: 21.25, maxX: 22.75, minZ: 3, maxZ: 20.5 },
  ],
  arrows: [
    // receiving -> inventory, up the cross aisle
    { x: -18, z: 14, heading: "N" },
    { x: -18, z: 7, heading: "N" },
    { x: -18, z: -5, heading: "N" },
    { x: -18, z: -12, heading: "N" },
    // inventory/assembly -> quality, along the main aisle
    { x: -10, z: 0, heading: "E" },
    { x: -2, z: 0, heading: "E" },
    { x: 6, z: 0, heading: "E" },
    { x: 14, z: 0, heading: "E" },
    { x: 22, z: 0, heading: "E" },
    // quality -> shipping, across the aisle
    { x: 30, z: -3, heading: "S" },
    { x: 30, z: 2.5, heading: "S" },
  ],
};

export const factoryLayout: FactoryObjectConfig[] = [
  // RECEIVING
  {
    id: "REC-001",
    name: "Receiving Dock A",
    type: "pallet",
    status: "running",
    capacity: 200,
    utilization: 0.72,
    department: "receiving",
    position: [-34, 0.75, 6],
    size: [4.4, 1.5, 2.8],
    color: 0x3b82f6,
  },
  {
    id: "REC-002",
    name: "Receiving Dock B",
    type: "pallet",
    status: "idle",
    capacity: 200,
    utilization: 0.15,
    department: "receiving",
    position: [-34, 0.75, 11.2],
    size: [4.4, 1.5, 2.8],
    color: 0x3b82f6,
  },
  {
    id: "REC-003",
    name: "Receiving Dock C",
    type: "pallet",
    status: "running",
    capacity: 200,
    utilization: 0.4,
    department: "receiving",
    position: [-34, 0.75, 16.4],
    size: [4.4, 1.5, 2.8],
    color: 0x3b82f6,
  },

  // RAW INVENTORY
  {
    id: "INV-001",
    name: "Raw Materials Rack A",
    type: "rack",
    status: "running",
    capacity: 500,
    utilization: 0.81,
    department: "inventory",
    position: [-33, 1.6, -16.5],
    size: [6, 3.2, 1.2],
    color: 0x06b6d4,
  },
  {
    id: "INV-002",
    name: "Raw Materials Rack B",
    type: "rack",
    status: "blocked",
    capacity: 500,
    utilization: 0.93,
    department: "inventory",
    position: [-25, 1.6, -16.5],
    size: [6, 3.2, 1.2],
    color: 0x06b6d4,
  },
  {
    id: "INV-003",
    name: "Raw Materials Rack C",
    type: "rack",
    status: "running",
    capacity: 500,
    utilization: 0.55,
    department: "inventory",
    position: [-33, 1.6, -9.5],
    size: [6, 3.2, 1.2],
    color: 0x06b6d4,
  },
  {
    id: "INV-004",
    name: "Raw Materials Rack D",
    type: "rack",
    status: "idle",
    capacity: 500,
    utilization: 0.3,
    department: "inventory",
    position: [-25, 1.6, -9.5],
    size: [6, 3.2, 1.2],
    color: 0x06b6d4,
  },

  // ASSEMBLY
  {
    id: "ASM-001",
    name: "Assembly Line A",
    type: "workstation",
    status: "running",
    capacity: 120,
    utilization: 0.84,
    department: "assembly",
    position: [-11.6, 0.8, -9.5],
    size: [4.4, 1.6, 2],
    color: 0xf59e0b,
  },
  {
    id: "ASM-002",
    name: "Assembly Line B",
    type: "workstation",
    status: "running",
    capacity: 110,
    utilization: 0.67,
    department: "assembly",
    position: [-4, 0.8, -9.5],
    size: [4.4, 1.6, 2],
    color: 0xf59e0b,
  },
  {
    id: "ASM-003",
    name: "Assembly Line C",
    type: "workstation",
    status: "down",
    capacity: 90,
    utilization: 0.0,
    department: "assembly",
    position: [3.6, 0.8, -9.5],
    size: [4.4, 1.6, 2],
    color: 0xf59e0b,
  },
  {
    id: "ASM-004",
    name: "Assembly Line D",
    type: "workstation",
    status: "running",
    capacity: 115,
    utilization: 0.6,
    department: "assembly",
    position: [-11.6, 0.8, -17.5],
    size: [4.4, 1.6, 2],
    color: 0xf59e0b,
  },
  {
    id: "ASM-005",
    name: "Assembly Line E",
    type: "workstation",
    status: "idle",
    capacity: 100,
    utilization: 0.2,
    department: "assembly",
    position: [-4, 0.8, -17.5],
    size: [4.4, 1.6, 2],
    color: 0xf59e0b,
  },
  {
    id: "ASM-006",
    name: "Assembly Line F",
    type: "workstation",
    status: "running",
    capacity: 95,
    utilization: 0.5,
    department: "assembly",
    position: [3.6, 0.8, -17.5],
    size: [4.4, 1.6, 2],
    color: 0xf59e0b,
  },

  // QUALITY CONTROL
  {
    id: "QC-001",
    name: "Inspection Cell A",
    type: "inspection",
    status: "running",
    capacity: 80,
    utilization: 0.58,
    department: "quality",
    position: [17.5, 0.95, -12],
    size: [3.6, 1.9, 2],
    color: 0x8b5cf6,
  },
  {
    id: "QC-002",
    name: "Inspection Cell B",
    type: "inspection",
    status: "idle",
    capacity: 80,
    utilization: 0.22,
    department: "quality",
    position: [24, 0.95, -12],
    size: [3.6, 1.9, 2],
    color: 0x8b5cf6,
  },
  {
    id: "QC-003",
    name: "Inspection Cell C",
    type: "inspection",
    status: "idle",
    capacity: 80,
    utilization: 0.1,
    department: "quality",
    position: [30.5, 0.95, -12],
    size: [3.6, 1.9, 2],
    color: 0x8b5cf6,
  },

  // SHIPPING
  {
    id: "SHP-001",
    name: "Shipping Bay A",
    type: "shipping",
    status: "running",
    capacity: 150,
    utilization: 0.76,
    department: "shipping",
    position: [34, 0.75, 6],
    size: [4.4, 1.5, 2.8],
    color: 0x22c55e,
  },
  {
    id: "SHP-002",
    name: "Shipping Bay B",
    type: "shipping",
    status: "blocked",
    capacity: 150,
    utilization: 0.88,
    department: "shipping",
    position: [34, 0.75, 11.2],
    size: [4.4, 1.5, 2.8],
    color: 0x22c55e,
  },
  {
    id: "SHP-003",
    name: "Shipping Bay C",
    type: "shipping",
    status: "idle",
    capacity: 150,
    utilization: 0.3,
    department: "shipping",
    position: [34, 0.75, 16.4],
    size: [4.4, 1.5, 2.8],
    color: 0x22c55e,
  },
];
