import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

export class CameraController {
  public readonly camera: THREE.PerspectiveCamera;

  private readonly controls: OrbitControls;

  constructor(canvas: HTMLCanvasElement, width: number, height: number) {
    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.5, 600);

    // Elevated three-quarter view of the 80 x 44 m facility (centred on
    // the origin), from the south-east so department names read upright.
    this.camera.position.set(34, 49, 65);

    this.controls = new OrbitControls(this.camera, canvas);

    this.controls.target.set(0, 0, 0);

    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;

    this.controls.minDistance = 5;
    this.controls.maxDistance = 160;

    this.controls.maxPolarAngle = Math.PI / 2 - 0.05;

    this.controls.update();
  }

  public update(): void {
    this.controls.update();
  }

  public resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  public dispose(): void {
    this.controls.dispose();
  }
}
