import * as THREE from "three";
import type { FactoryObjectConfig } from "./FactoryObject";

export class InteractionManager {
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();

  private hovered: THREE.Mesh | null = null;
  private selected: THREE.Mesh | null = null;

  private readonly originalColors = new Map<THREE.Mesh, THREE.Color>();

  private readonly camera: THREE.Camera;
  private readonly canvas: HTMLCanvasElement;
  private readonly selectableObjects: THREE.Object3D[];
  private readonly onSelect: (object: FactoryObjectConfig | null) => void;

  constructor(
    camera: THREE.Camera,
    canvas: HTMLCanvasElement,
    selectableObjects: THREE.Object3D[],
    onSelect: (object: FactoryObjectConfig | null) => void,
  ) {
    this.camera = camera;
    this.canvas = canvas;
    this.selectableObjects = selectableObjects;
    this.onSelect = onSelect;

    canvas.addEventListener("pointermove", this.handlePointerMove);

    canvas.addEventListener("click", this.handleClick);
  }

  private getIntersectedMesh(
    event: PointerEvent | MouseEvent,
  ): THREE.Mesh | null {
    const rect = this.canvas.getBoundingClientRect();

    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;

    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.pointer, this.camera);

    const intersections = this.raycaster.intersectObjects(
      this.selectableObjects,
      true,
    );

    for (const intersection of intersections) {
      // A station is several meshes; every part points at the one
      // status-coloured body that represents the station.
      const body = intersection.object.userData.statusMesh as
        THREE.Mesh | undefined;
      if (body) return body;
    }

    return null;
  }

  private rememberColor(mesh: THREE.Mesh): void {
    if (this.originalColors.has(mesh)) return;

    const material = mesh.material;

    if (material instanceof THREE.MeshStandardMaterial) {
      this.originalColors.set(mesh, material.color.clone());
    }
  }

  private updateHighlights(): void {
    for (const [mesh, color] of this.originalColors) {
      const material = mesh.material;

      if (!(material instanceof THREE.MeshStandardMaterial)) {
        continue;
      }

      // The visualizer may have recoloured the mesh since it was remembered.
      const base = (mesh.userData.baseColor as THREE.Color | undefined) ?? color;

      material.color.copy(base);

      // Tell the visualizer which overlay to keep when it recolours the
      // mesh for a status change, so selection and status never fight.
      let overlay: string | undefined;
      if (mesh === this.selected) overlay = "#facc15";
      else if (mesh === this.hovered) overlay = "#ffffff";

      mesh.userData.highlightColor = overlay;
      if (overlay) material.color.set(overlay);
    }
  }

  private handlePointerMove = (event: PointerEvent): void => {
    const mesh = this.getIntersectedMesh(event);

    if (mesh === this.hovered) return;

    this.hovered = mesh;

    if (mesh) {
      this.rememberColor(mesh);
    }

    this.canvas.style.cursor = mesh ? "pointer" : "grab";

    this.updateHighlights();
  };

  private handleClick = (event: MouseEvent): void => {
    this.select(this.getIntersectedMesh(event));
  };

  /** Select a station programmatically (same path as a canvas click). */
  public select(mesh: THREE.Mesh | null): void {
    this.selected = mesh;

    if (mesh) {
      this.rememberColor(mesh);
    }

    this.updateHighlights();

    const config = mesh?.userData.factoryObject as
      FactoryObjectConfig | undefined;

    this.onSelect(config ?? null);
  }

  public dispose(): void {
    this.canvas.removeEventListener("pointermove", this.handlePointerMove);

    this.canvas.removeEventListener("click", this.handleClick);

    for (const [mesh, color] of this.originalColors) {
      const material = mesh.material;

      if (material instanceof THREE.MeshStandardMaterial) {
        material.color.copy(color);
      }
    }

    this.originalColors.clear();
    this.canvas.style.cursor = "";
  }
}
