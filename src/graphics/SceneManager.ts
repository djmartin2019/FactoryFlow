import * as THREE from "three";
import { CameraController } from "./CameraController";
import { Factory } from "./Factory";
import { InteractionManager } from "./InteractionManager";
import type { SimulationController } from "../simulation/SimulationController";
import { FactoryVisualizer } from "./FactoryVisualizer";
import StationDetails from "../ui/StationDetails";

export class SceneManager {
  private readonly scene: THREE.Scene;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly cameraController: CameraController;
  private readonly interactionManager: InteractionManager;
  private readonly stationDetails: StationDetails;
  private readonly simulation: SimulationController;
  private readonly clock = new THREE.Clock();
  private readonly factory: Factory;
  private readonly visualizer: FactoryVisualizer;
  private lastVisualizedSequence = -1;
  private readonly resizeObserver: ResizeObserver;
  private readonly onSelectionChange?: (id: string | null) => void;

  constructor(
    container: HTMLElement,
    simulation: SimulationController,
    options: { onSelectionChange?: (id: string | null) => void } = {},
  ) {
    this.onSelectionChange = options.onSelectionChange;
    this.simulation = simulation;
    this.scene = new THREE.Scene();

    this.scene.background = new THREE.Color("#101827");

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
    });

    this.renderer.setSize(container.clientWidth, container.clientHeight);

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    container.appendChild(this.renderer.domElement);

    this.cameraController = new CameraController(
      this.renderer.domElement,
      container.clientWidth,
      container.clientHeight,
    );

    this.setupLighting();
    this.factory = new Factory();
    this.scene.add(this.factory.group);
    const factory = this.factory;

    this.visualizer = new FactoryVisualizer(factory.objectsById);
    this.syncVisuals();

    this.stationDetails = new StationDetails(container);

    this.interactionManager = new InteractionManager(
      this.cameraController.camera,
      this.renderer.domElement,
      factory.selectableObjects,
      (selectedObject) => {
        this.stationDetails.render(selectedObject);
        this.onSelectionChange?.(selectedObject?.id ?? null);
      },
    );

    // The viewport is a layout cell, so observe it rather than the window.
    this.resizeObserver = new ResizeObserver(this.handleResize);
    this.resizeObserver.observe(container);

    this.renderer.setAnimationLoop(this.animate);
  }

  public get details(): StationDetails {
    return this.stationDetails;
  }

  /** Select (and highlight) a station by layout id, as if it were clicked. */
  public select(id: string | null): void {
    const mesh = id ? this.factory.objectsById.get(id) : undefined;
    this.interactionManager.select(mesh ?? null);
  }

  private setupLighting(): void {
    const ambientLight = new THREE.AmbientLight(0xffffff, 1.5);

    this.scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 2);

    // Off to the south-east, above the building, so benches and racks get
    // clear top/side shading across the whole 56 x 32 m floor.
    directionalLight.position.set(20, 40, 25);

    this.scene.add(directionalLight);
  }

  private animate = (): void => {
    const deltaSeconds = this.clock.getDelta();

    this.simulation.update(deltaSeconds);

    this.syncVisuals();

    this.cameraController.update();

    this.factory.updateLabels(
      this.cameraController.camera,
      this.renderer.domElement.clientHeight,
    );

    this.renderer.render(this.scene, this.cameraController.camera);
  };

  /** Only re-derive visuals when an event has actually been applied. */
  private syncVisuals(): void {
    const state = this.simulation.state;

    if (state.lastSequence === this.lastVisualizedSequence) return;
    this.lastVisualizedSequence = state.lastSequence;

    this.visualizer.update(state, this.simulation.engine.master);
  }

  private handleResize = (): void => {
    const container = this.renderer.domElement.parentElement;

    if (!container) return;

    const width = container.clientWidth;
    const height = container.clientHeight;

    this.cameraController.resize(width, height);

    this.renderer.setSize(width, height);
  };

  public dispose(): void {
    this.renderer.setAnimationLoop(null);

    this.resizeObserver.disconnect();

    this.cameraController.dispose();
    this.interactionManager.dispose();

    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();

        const materials = Array.isArray(object.material)
          ? object.material
          : [object.material];

        materials.forEach((material) => material.dispose());
      }
    });

    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
