import {
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  EllipsoidTerrainProvider,
  GridImageryProvider,
  HeightReference,
  ImageryLayer,
  Ion,
  LabelStyle,
  Math as CesiumMath,
  SceneMode,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  TileMapServiceImageryProvider,
  VerticalOrigin,
  Viewer,
} from 'cesium';
import { sceneConfig } from '../../config/scene';
import { initialSnapshot } from './types';
import type { BasemapName, GeoPosition, SceneSnapshot } from './types';

/** Owns the Viewer and all Cesium resources. React only receives serializable data. */
export class SceneController {
  private readonly viewer: Viewer;
  private readonly input: ScreenSpaceEventHandler;
  private readonly disposers: Array<() => void> = [];
  private naturalLayer?: ImageryLayer;
  private gridLayer?: ImageryLayer;
  private disposed = false;
  private snapshot = { ...initialSnapshot };
  private lastPointerUpdate = 0;
  private selectedBasemap: BasemapName = 'natural';
  private requestedGrid = false;

  constructor(
    container: HTMLElement,
    private readonly onChange: (state: SceneSnapshot) => void,
  ) {
    // No ion account or external service is needed for this first local scene.
    window.CESIUM_BASE_URL = sceneConfig.cesiumBaseUrl;
    Ion.defaultAccessToken = '';
    this.viewer = new Viewer(container, {
      baseLayer: false,
      terrainProvider: new EllipsoidTerrainProvider(),
      animation: false,
      timeline: false,
      geocoder: false,
      baseLayerPicker: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      requestRenderMode: true,
      maximumRenderTimeChange: Number.POSITIVE_INFINITY,
      shouldAnimate: false,
    });
    const scene = this.viewer.scene;
    scene.backgroundColor = Color.fromCssColorString('#020711');
    if (scene.skyBox) scene.skyBox.show = false;
    scene.globe.baseColor = Color.fromCssColorString('#1d3549');
    scene.globe.enableLighting = false;
    scene.screenSpaceCameraController.minimumZoomDistance = 100;
    scene.screenSpaceCameraController.maximumZoomDistance = 100_000_000;
    this.viewer.camera.percentageChanged = 0.01;
    this.home(false);

    this.input = new ScreenSpaceEventHandler(scene.canvas);
    this.input.setInputAction(({ endPosition }: { endPosition: Cartesian2 }) => {
      const now = performance.now();
      if (now - this.lastPointerUpdate < 60) return;
      this.lastPointerUpdate = now;
      this.emit({ pointer: this.pick(endPosition) });
    }, ScreenSpaceEventType.MOUSE_MOVE);
    this.input.setInputAction(({ position }: { position: Cartesian2 }) => {
      const point = this.pick(position);
      if (point) this.select(point);
    }, ScreenSpaceEventType.LEFT_CLICK);
    const onLeave = () => this.emit({ pointer: null });
    scene.canvas.addEventListener('mouseleave', onLeave);
    this.disposers.push(() => scene.canvas.removeEventListener('mouseleave', onLeave));
    this.disposers.push(this.viewer.camera.changed.addEventListener(() => this.updateCamera()));
    this.disposers.push(this.viewer.camera.moveEnd.addEventListener(() => this.updateCamera()));
    this.disposers.push(
      scene.morphStart.addEventListener(() => this.emit({ transitioning: true, pointer: null })),
    );
    this.disposers.push(
      scene.morphComplete.addEventListener(() => {
        this.emit({ transitioning: false });
        this.updateCamera();
      }),
    );
    this.disposers.push(
      scene.renderError.addEventListener((_scene, error: Error) => {
        this.emit({ status: 'error', error: `场景渲染失败：${error.message}` });
      }),
    );
    this.updateCamera();
    void this.loadImagery();
  }

  private emit(patch: Partial<SceneSnapshot>) {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    this.onChange(this.snapshot);
  }

  private async loadImagery() {
    try {
      const provider = await TileMapServiceImageryProvider.fromUrl(
        `${sceneConfig.cesiumBaseUrl}Assets/Textures/NaturalEarthII`,
      );
      // A StrictMode cleanup or unmount may happen while the image manifest loads.
      if (this.disposed) return;
      this.naturalLayer = this.viewer.imageryLayers.addImageryProvider(provider);
      this.naturalLayer.brightness = 0.9;
      this.naturalLayer.contrast = 1.1;
      this.naturalLayer.show = this.selectedBasemap === 'natural';
      this.disposers.push(
        provider.errorEvent.addEventListener(() => {
          this.emit({
            status: 'error',
            error: '本地底图瓦片加载失败，请检查 Cesium 静态资源路径后重试。',
          });
        }),
      );
      this.gridLayer = this.viewer.imageryLayers.addImageryProvider(
        new GridImageryProvider({
          cells: 8,
          color: Color.fromCssColorString('#9cd8e8').withAlpha(0.24),
          glowColor: Color.TRANSPARENT,
          backgroundColor: Color.TRANSPARENT,
        }),
      );
      this.gridLayer.show = this.requestedGrid;
      this.emit({ status: 'ready', error: undefined });
      this.viewer.scene.requestRender();
    } catch (error) {
      this.emit({
        status: 'error',
        error: `底图初始化失败：${error instanceof Error ? error.message : '未知错误'}`,
      });
    }
  }

  private updateCamera() {
    // Heading and cartographic position are temporarily undefined while morphing.
    if (this.viewer.scene.mode === SceneMode.MORPHING) return;
    this.emit({
      cameraHeight: this.viewer.camera.positionCartographic.height,
      heading: CesiumMath.toDegrees(this.viewer.camera.heading),
      mode: this.viewer.scene.mode === SceneMode.SCENE2D ? '2D' : '3D',
    });
  }

  private pick(position: Cartesian2): GeoPosition | null {
    if (this.viewer.scene.mode === SceneMode.MORPHING) return null;
    // The current surface is an ellipsoid. Intersect it exactly: picking its
    // coarse rendered mesh at global scale can otherwise report false negative heights.
    // Real terrain will require globe/terrain picking when it is introduced.
    const point = this.viewer.camera.pickEllipsoid(position, this.viewer.scene.globe.ellipsoid);
    if (!point) return null;
    const location = Cartographic.fromCartesian(point);
    return {
      longitude: CesiumMath.toDegrees(location.longitude),
      latitude: CesiumMath.toDegrees(location.latitude),
      height: 0,
    };
  }

  select(position: GeoPosition) {
    this.viewer.entities.removeById('selected-position');
    this.viewer.entities.add({
      id: 'selected-position',
      position: Cartesian3.fromDegrees(position.longitude, position.latitude, position.height),
      point: {
        pixelSize: 9,
        color: Color.fromCssColorString('#a4f2d3'),
        outlineColor: Color.fromCssColorString('#173c46'),
        outlineWidth: 3,
        heightReference: HeightReference.NONE,
      },
      label: {
        text: `${position.longitude.toFixed(3)}°, ${position.latitude.toFixed(3)}°`,
        font: '12px sans-serif',
        fillColor: Color.WHITE,
        outlineColor: Color.fromCssColorString('#081320'),
        outlineWidth: 4,
        style: LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cartesian2(0, -18),
        verticalOrigin: VerticalOrigin.BOTTOM,
      },
    });
    this.emit({ selection: position });
    this.viewer.scene.requestRender();
  }

  clearSelection() {
    this.viewer.entities.removeById('selected-position');
    this.emit({ selection: null });
    this.viewer.scene.requestRender();
  }

  locate(longitude: number, latitude: number, cameraAltitude: number) {
    this.select({ longitude, latitude, height: 0 });
    this.viewer.camera.flyTo({
      destination: Cartesian3.fromDegrees(longitude, latitude, cameraAltitude),
      duration: 1.4,
      orientation: { heading: 0, pitch: -CesiumMath.PI_OVER_TWO, roll: 0 },
    });
  }

  home(animate = true) {
    this.setView(sceneConfig.initialView, animate);
  }

  globalView() {
    this.setView(sceneConfig.globalView, true);
  }

  private setView(
    view: { longitude: number; latitude: number; altitude: number },
    animate: boolean,
  ) {
    const options = {
      destination: Cartesian3.fromDegrees(view.longitude, view.latitude, view.altitude),
      orientation: { heading: 0, pitch: -CesiumMath.PI_OVER_TWO, roll: 0 },
    };
    if (animate) this.viewer.camera.flyTo({ ...options, duration: 1.2 });
    else this.viewer.camera.setView(options);
  }

  zoom(direction: 'in' | 'out') {
    const amount = Math.max(50, this.viewer.camera.positionCartographic.height * 0.35);
    if (direction === 'in') this.viewer.camera.zoomIn(amount);
    else this.viewer.camera.zoomOut(amount);
    this.viewer.scene.requestRender();
    this.updateCamera();
  }

  northUp() {
    if (this.viewer.scene.mode !== SceneMode.SCENE3D) return;
    this.viewer.camera.flyTo({
      destination: this.viewer.camera.positionWC,
      orientation: { heading: 0, pitch: this.viewer.camera.pitch, roll: 0 },
      duration: 0.6,
    });
  }

  setMode(mode: '2D' | '3D') {
    if (this.viewer.scene.mode === SceneMode.MORPHING || this.snapshot.mode === mode) return;
    if (mode === '2D') this.viewer.scene.morphTo2D(0.6);
    else this.viewer.scene.morphTo3D(0.6);
  }

  setBasemap(name: BasemapName) {
    this.selectedBasemap = name;
    if (this.naturalLayer) this.naturalLayer.show = name === 'natural';
    this.viewer.scene.requestRender();
  }

  setGrid(show: boolean) {
    this.requestedGrid = show;
    if (this.gridLayer) this.gridLayer.show = show;
    this.viewer.scene.requestRender();
  }

  setLighting(enabled: boolean) {
    this.viewer.scene.globe.enableLighting = enabled;
    this.viewer.scene.requestRender();
  }

  destroy() {
    if (this.disposed) return;
    this.disposed = true;
    this.disposers.forEach((dispose) => dispose());
    this.input.destroy();
    this.viewer.destroy();
  }
}
