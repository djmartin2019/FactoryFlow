/**
 * Pure layout types (no three.js) so the layout data can be consumed by
 * the node-side manufacturing code and tests as well as the renderer.
 */

export type DepartmentId =
  "receiving" | "inventory" | "assembly" | "quality" | "shipping";

/** Axis-aligned rectangle on the floor plane: x is east, z is south. */
export interface FloorRect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface DepartmentConfig {
  id: DepartmentId;
  name: string;
  /** Muted floor tint; deliberately distinct from status colours. */
  color: number;
  bounds: FloorRect;
}

export interface BuildingConfig {
  bounds: FloorRect;
  wallHeight: number;
  wallThickness: number;
}

export interface DockDoorConfig {
  wall: "west" | "east";
  /** Position along the wall (world z). */
  z: number;
  width: number;
  department: DepartmentId;
}

/** Direction on the floor plane. N is -z, E is +x. */
export type Heading = "N" | "E" | "S" | "W";

export interface FlowArrowConfig {
  x: number;
  z: number;
  heading: Heading;
}

export interface FloorMarkingsConfig {
  /** Material-handling aisles: yellow edge lines around the rectangle. */
  aisles: FloorRect[];
  /** Pedestrian walkways: filled strip with white edge lines. */
  walkways: FloorRect[];
  arrows: FlowArrowConfig[];
}
