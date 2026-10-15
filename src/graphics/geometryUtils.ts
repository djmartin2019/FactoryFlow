import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

import type { FloorRect } from "../data/layoutTypes";

/** A box of `size` centred at `pos`, as non-indexed geometry for merging. */
export function boxAt(
  size: readonly [number, number, number],
  pos: readonly [number, number, number],
): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(...size).toNonIndexed();
  geometry.translate(...pos);
  return geometry;
}

/** A horizontal rectangle lying on the floor plane at height `y`. */
export function flatRect(rect: FloorRect, y: number): THREE.BufferGeometry {
  const geometry = new THREE.PlaneGeometry(
    rect.maxX - rect.minX,
    rect.maxZ - rect.minZ,
  ).toNonIndexed();
  geometry.rotateX(-Math.PI / 2);
  geometry.translate((rect.minX + rect.maxX) / 2, y, (rect.minZ + rect.maxZ) / 2);
  return geometry;
}

/** Four thin rectangles tracing the outside of `rect`. */
export function outlineRects(rect: FloorRect, t: number): FloorRect[] {
  return [
    { minX: rect.minX, maxX: rect.maxX, minZ: rect.minZ, maxZ: rect.minZ + t },
    { minX: rect.minX, maxX: rect.maxX, minZ: rect.maxZ - t, maxZ: rect.maxZ },
    { minX: rect.minX, maxX: rect.minX + t, minZ: rect.minZ + t, maxZ: rect.maxZ - t },
    { minX: rect.maxX - t, maxX: rect.maxX, minZ: rect.minZ + t, maxZ: rect.maxZ - t },
  ];
}

export function mergeAll(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(geometries);
  geometries.forEach((g) => g.dispose());
  if (!merged) throw new Error("Geometry merge failed (mismatched attributes)");
  return merged;
}

/** Decorative objects must never be hit by the selection raycaster. */
export function makeNonInteractive(object: THREE.Object3D): void {
  object.traverse((child) => {
    child.raycast = () => {};
  });
}

/**
 * Pulls a decal towards the camera in depth so floor markings never
 * z-fight with the floor, grid or each other. Higher `layer` wins.
 */
export function decalMaterial(
  params: THREE.MeshBasicMaterialParameters,
  layer: number,
): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    ...params,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -layer,
    polygonOffsetUnits: -layer,
  });
}
