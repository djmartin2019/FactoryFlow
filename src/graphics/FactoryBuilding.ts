import * as THREE from "three";

import type { BuildingConfig, DockDoorConfig } from "../data/layoutTypes";
import { boxAt, makeNonInteractive, mergeAll } from "./geometryUtils";

const GRID_SPACING = 2;
const GRID_Y = 0.01;
const DOOR_HEIGHT = 3.6;

/**
 * Shell of the facility: floor, perimeter walls, floor grid and dock doors.
 * The south wall is left open (only a low curb) so the default
 * three-quarter camera can see in.
 */
export class FactoryBuilding {
  public readonly group = new THREE.Group();

  constructor(config: BuildingConfig, doors: DockDoorConfig[]) {
    this.group.name = "building";

    const { minX, maxX, minZ, maxZ } = config.bounds;
    const width = maxX - minX;
    const depth = maxZ - minZ;
    const { wallHeight: h, wallThickness: t } = config;

    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(width, 0.2, depth),
      // Sealed concrete: light enough for shadows to read, dark enough for the floor markings.
      new THREE.MeshStandardMaterial({ color: "#4b5361", roughness: 0.7 }),
    );
    floor.position.set((minX + maxX) / 2, -0.1, (minZ + maxZ) / 2);
    floor.receiveShadow = true;

    const wallMaterial = new THREE.MeshStandardMaterial({
      color: "#64748b",
      roughness: 0.85,
      side: THREE.DoubleSide,
    });
    const walls = new THREE.Mesh(
      mergeAll([
        boxAt([width + t, h, t], [(minX + maxX) / 2, h / 2, minZ]), // north
        boxAt([t, h, depth], [minX, h / 2, (minZ + maxZ) / 2]), // west
        boxAt([t, h, depth], [maxX, h / 2, (minZ + maxZ) / 2]), // east
        boxAt([width + t, 0.4, t], [(minX + maxX) / 2, 0.2, maxZ]), // south curb
      ]),
      wallMaterial,
    );
    // Walls cast but do not receive: at grazing light angles they only show shadow acne.
    walls.castShadow = true;

    this.group.add(floor, walls, this.createGrid(config), this.createDoors(config, doors));
    makeNonInteractive(this.group);
  }

  /** One LineSegments for the whole grid, clipped to the building. */
  private createGrid(config: BuildingConfig): THREE.LineSegments {
    const { minX, maxX, minZ, maxZ } = config.bounds;
    const points: number[] = [];
    for (let x = minX; x <= maxX + 1e-6; x += GRID_SPACING) {
      points.push(x, GRID_Y, minZ, x, GRID_Y, maxZ);
    }
    for (let z = minZ; z <= maxZ + 1e-6; z += GRID_SPACING) {
      points.push(minX, GRID_Y, z, maxX, GRID_Y, z);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
    return new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({ color: "#64748b", transparent: true, opacity: 0.35 }),
    );
  }

  /** Dark door openings with light frames on the interior wall faces. */
  private createDoors(config: BuildingConfig, doors: DockDoorConfig[]): THREE.Group {
    const group = new THREE.Group();
    const { minX, maxX } = config.bounds;
    const inset = config.wallThickness / 2 + 0.05;

    const openings: THREE.BufferGeometry[] = [];
    const frames: THREE.BufferGeometry[] = [];
    for (const door of doors) {
      const x = door.wall === "west" ? minX + inset : maxX - inset;
      const half = door.width / 2;
      openings.push(boxAt([0.1, DOOR_HEIGHT, door.width], [x, DOOR_HEIGHT / 2, door.z]));
      for (const side of [-1, 1]) {
        frames.push(boxAt([0.2, DOOR_HEIGHT + 0.3, 0.2],
          [x, (DOOR_HEIGHT + 0.3) / 2, door.z + side * (half + 0.1)]));
      }
      frames.push(boxAt([0.2, 0.3, door.width + 0.4], [x, DOOR_HEIGHT + 0.15, door.z]));
    }
    if (openings.length === 0) return group;

    group.add(
      new THREE.Mesh(mergeAll(openings), new THREE.MeshStandardMaterial({ color: "#0f172a", roughness: 0.8 })),
      new THREE.Mesh(mergeAll(frames), new THREE.MeshStandardMaterial({ color: "#cbd5e1", roughness: 0.6 })),
    );
    return group;
  }
}
