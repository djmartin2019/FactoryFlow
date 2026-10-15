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
 * camera), +y is up. The building is centred on the origin.
 *
 *   north wall (z = -16)
 *   +--------------------------------------------------------+
 *   | INVENTORY        |  ASSEMBLY                | QUALITY   |
 *   |                  |                          |           |
 *   |===== main material-handling aisle (z -2..2) ============|
 *   | RECEIVING        |  (open yard, future use) | SHIPPING  |
 *   +--------------------------------------------------------+
 *   west wall (x=-28)                              east wall (x=28)
 *
 * Flow is a U: dock in (west) -> inventory -> assembly -> quality -> ship
 * out (east). Receiving and shipping sit on the west/east exterior walls.
 */
export const building: BuildingConfig = {
  bounds: { minX: -28, maxX: 28, minZ: -16, maxZ: 16 },
  wallHeight: 8,
  wallThickness: 0.6,
};

export const departments: DepartmentConfig[] = [
  { id: "receiving", name: "Receiving", color: 0x3f6fb5,
    bounds: { minX: -26, maxX: -12, minZ: 3, maxZ: 14 } },
  { id: "inventory", name: "Raw Material Inventory", color: 0x7a5fb0,
    bounds: { minX: -26, maxX: -12, minZ: -13, maxZ: -4 } },
  { id: "assembly", name: "Assembly", color: 0x2f9a93,
    bounds: { minX: -8, maxX: 12, minZ: -13, maxZ: -4 } },
  { id: "quality", name: "Quality Control", color: 0xb08a3e,
    bounds: { minX: 14, maxX: 26, minZ: -13, maxZ: -4 } },
  { id: "shipping", name: "Shipping", color: 0x55a066,
    bounds: { minX: 14, maxX: 26, minZ: 3, maxZ: 14 } },
];

/** Dock doors line up with the staging pads (z = 5.8 and 10.6). */
export const dockDoors: DockDoorConfig[] = [
  { wall: "west", z: 5.8, width: 3, department: "receiving" },
  { wall: "west", z: 10.6, width: 3, department: "receiving" },
  { wall: "east", z: 5.8, width: 3, department: "shipping" },
  { wall: "east", z: 10.6, width: 3, department: "shipping" },
];

export const floorMarkings: FloorMarkingsConfig = {
  // 4 m main aisle (z -2..2) and the 4 m cross aisle between inventory and
  // assembly (x -12..-8).
  aisles: [
    { minX: -26, maxX: 26, minZ: -2, maxZ: 2 },
    { minX: -12, maxX: -8, minZ: -13, maxZ: -2 },
  ],
  // 1.5 m pedestrian walkways in the 2 m gaps beside quality / shipping.
  walkways: [
    { minX: 12.25, maxX: 13.75, minZ: -13, maxZ: -4 },
    { minX: 12.25, maxX: 13.75, minZ: 3, maxZ: 14 },
  ],
  arrows: [
    // receiving -> inventory, up the cross aisle
    { x: -10, z: 7, heading: "N" },
    { x: -10, z: -5, heading: "N" },
    { x: -10, z: -10, heading: "N" },
    // inventory/assembly -> quality, along the main aisle
    { x: -4, z: 0, heading: "E" },
    { x: 3, z: 0, heading: "E" },
    { x: 10, z: 0, heading: "E" },
    { x: 17, z: 0, heading: "E" },
    // quality -> shipping, across the aisle
    { x: 20, z: -3, heading: "S" },
    { x: 20, z: 2.5, heading: "S" },
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
    position: [-22, 0.75, 5.8],
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
    position: [-22, 0.75, 10.6],
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
    position: [-19, 1.6, -11.5],
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
    position: [-19, 1.6, -6.5],
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
    position: [-5.2, 0.8, -8.5],
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
    position: [1.4, 0.8, -8.5],
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
    position: [8, 0.8, -8.5],
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
    position: [17.5, 0.95, -8.5],
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
    position: [23.5, 0.95, -8.5],
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
    position: [22, 0.75, 5.8],
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
    position: [22, 0.75, 10.6],
    size: [4.4, 1.5, 2.8],
    color: 0x22c55e,
  },
];
