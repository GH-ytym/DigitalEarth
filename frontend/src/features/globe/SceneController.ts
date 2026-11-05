import {
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  createWorldImageryAsync,
  createWorldTerrainAsync,
  EllipsoidTerrainProvider,
  GridImageryProvider,
  HeightReference,
  ImageryLayer,
  Ion,
  IonWorldImageryStyle,
  LabelStyle,
  Math as CesiumMath,
  SceneMode,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  sampleTerrainMostDetailed,
  VerticalOrigin,
  Viewer,
} from 'cesium';
import { sceneConfig } from '../../config/scene';
import { initialSnapshot } from './types';
import type { GeoPosition, SelectedPosition, SceneSnapshot, TerrainStatus } from './types';
import type { PlaceResult } from '../locations/types';

/** Owns the Viewer and all Cesium resources. React only receives serializable data. */
export class SceneController {
  private readonly viewer: Viewer;
  private readonly input: ScreenSpaceEventHandler;
  private readonly disposers: Array<() => void> = [];
  private gridLayer?: ImageryLayer;
  private disposed = false;
  private snapshot = { ...initialSnapshot };
  private lastPointerUpdate = 0;
  private requestedGrid = false;
  private terrainRequestId = 0;
  private selectionRevision = 0;
  private removeTerrainErrorListener?: () => void;

  constructor(
    container: HTMLElement,
    private readonly onChange: (state: SceneSnapshot) => void,
  ) {
    window.CESIUM_BASE_URL = sceneConfig.cesiumBaseUrl;
    Ion.defaultAccessToken = sceneConfig.ionToken;
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
    scene.backgroundColor = Color.fromCssColorString('#06162e');
    if (scene.skyBox) scene.skyBox.show = false;
    scene.globe.baseColor = Color.fromCssColorString('#0a2345');
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
    this.gridLayer = this.viewer.imageryLayers.addImageryProvider(
      new GridImageryProvider({
        cells: 8,
        color: Color.WHITE.withAlpha(0.24),
        glowColor: Color.TRANSPARENT,
        backgroundColor: Color.TRANSPARENT,
      }),
    );
    this.gridLayer.show = this.requestedGrid;
    void this.loadImagery();
    void this.setTerrainEnabled(true);
  }

  private emit(patch: Partial<SceneSnapshot>) {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    this.onChange(this.snapshot);
  }

  private async loadImagery() {
    if (!sceneConfig.ionToken) {
      this.emit({
        status: 'error',
        error: '未配置 Cesium ion Token，无法加载全球影像。请在 .env.local 中配置后重启服务。',
      });
      return;
    }
    try {
      const provider = await createWorldImageryAsync({ style: IonWorldImageryStyle.AERIAL });
      // A StrictMode cleanup or unmount may happen while ion metadata loads.
      if (this.disposed) return;
      this.viewer.imageryLayers.addImageryProvider(provider, 0);
      this.disposers.push(
        provider.errorEvent.addEventListener(() => {
          this.emit({
            status: 'error',
            error: '全球影像瓦片加载失败，请检查 Cesium ion Token 的影像读取权限和网络后重试。',
          });
        }),
      );
      this.emit({ status: 'ready', error: undefined });
      this.viewer.scene.requestRender();
    } catch {
      this.emit({
        status: 'error',
        error: '全球影像服务连接失败，请检查 Cesium ion Token 的影像读取权限和网络后重试。',
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
    if (this.snapshot.terrainStatus === 'ready') {
      const ray = this.viewer.camera.getPickRay(position);
      const point = ray && this.viewer.scene.globe.pick(ray, this.viewer.scene);
      if (!point) return null;
      const location = Cartographic.fromCartesian(point);
      return {
        longitude: CesiumMath.toDegrees(location.longitude),
        latitude: CesiumMath.toDegrees(location.latitude),
        height: Number.isFinite(location.height) ? location.height : null,
      };
    }
    // Use an exact ellipsoid intersection while no real terrain is active.
    const point = this.viewer.camera.pickEllipsoid(position, this.viewer.scene.globe.ellipsoid);
    if (!point) return null;
    const location = Cartographic.fromCartesian(point);
    return {
      longitude: CesiumMath.toDegrees(location.longitude),
      latitude: CesiumMath.toDegrees(location.latitude),
      height: 0,
    };
  }

  select(position: SelectedPosition) {
    this.selectionRevision++;
    const heightReference =
      this.snapshot.terrainStatus === 'ready'
        ? HeightReference.CLAMP_TO_GROUND
        : HeightReference.NONE;
    this.viewer.entities.removeById('selected-position');
    this.viewer.entities.add({
      id: 'selected-position',
      position: Cartesian3.fromDegrees(position.longitude, position.latitude, position.height ?? 0),
      point: {
        pixelSize: 9,
        color: Color.WHITE,
        outlineColor: Color.fromCssColorString('#17559a'),
        outlineWidth: 3,
        heightReference,
      },
      label: {
        text: position.place?.name ?? `${position.longitude.toFixed(3)}°, ${position.latitude.toFixed(3)}°`,
        font: '12px sans-serif',
        fillColor: Color.WHITE,
        outlineColor: Color.fromCssColorString('#081320'),
        outlineWidth: 4,
        style: LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cartesian2(0, -18),
        verticalOrigin: VerticalOrigin.BOTTOM,
        heightReference,
      },
    });
    this.emit({ selection: position });
    this.viewer.scene.requestRender();
  }

  clearSelection() {
    this.selectionRevision++;
    this.viewer.entities.removeById('selected-position');
    this.emit({ selection: null });
    this.viewer.scene.requestRender();
  }

  locate(longitude: number, latitude: number, cameraAltitude: number, place?: PlaceResult) {
    const useTerrain = this.snapshot.terrainStatus === 'ready';
    this.select({ longitude, latitude, height: useTerrain ? null : 0, place });
    if (useTerrain) void this.sampleSelectedHeight(longitude, latitude);
    this.viewer.camera.flyTo({
      destination: Cartesian3.fromDegrees(longitude, latitude, cameraAltitude),
      duration: 1.4,
      orientation: { heading: 0, pitch: -CesiumMath.PI_OVER_TWO, roll: 0 },
    });
  }

  private async sampleSelectedHeight(longitude: number, latitude: number) {
    const revision = this.selectionRevision;
    const requestId = this.terrainRequestId;
    try {
      const [point] = await sampleTerrainMostDetailed(this.viewer.terrainProvider, [
        Cartographic.fromDegrees(longitude, latitude),
      ]);
      if (
        this.disposed ||
        revision !== this.selectionRevision ||
        requestId !== this.terrainRequestId
      )
        return;
      if (Number.isFinite(point.height) && this.snapshot.selection) {
        this.select({ ...this.snapshot.selection, height: point.height });
      }
    } catch {
      // Keep an unknown height unknown; do not manufacture a zero elevation.
    }
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

  setGrid(show: boolean) {
    this.requestedGrid = show;
    if (this.gridLayer) this.gridLayer.show = show;
    this.viewer.scene.requestRender();
  }

  async setTerrainEnabled(enabled: boolean) {
    if (this.disposed) return;
    if (
      enabled &&
      (this.snapshot.terrainStatus === 'loading' || this.snapshot.terrainStatus === 'ready')
    )
      return;
    const requestId = ++this.terrainRequestId;
    this.removeTerrainErrorListener?.();
    this.removeTerrainErrorListener = undefined;
    if (!sceneConfig.ionToken) {
      this.restoreEllipsoid('unconfigured');
      return;
    }
    if (!enabled) {
      this.restoreEllipsoid('disabled');
      return;
    }
    this.emit({ terrainStatus: 'loading', terrainError: undefined });
    try {
      const provider = await createWorldTerrainAsync();
      if (this.disposed || requestId !== this.terrainRequestId) return;
      this.removeTerrainErrorListener = provider.errorEvent.addEventListener(() => {
        if (this.disposed || requestId !== this.terrainRequestId) return;
        ++this.terrainRequestId;
        this.removeTerrainErrorListener?.();
        this.removeTerrainErrorListener = undefined;
        this.restoreEllipsoid(
          'error',
          '地形瓦片加载失败，已恢复椭球面。请检查访问权限和网络后重试。',
        );
      });
      this.viewer.terrainProvider = provider;
      this.clearSelection();
      this.emit({ terrainStatus: 'ready', terrainError: undefined, pointer: null });
      this.viewer.scene.requestRender();
    } catch {
      if (this.disposed || requestId !== this.terrainRequestId) return;
      // Do not echo service URLs or access tokens into interface error messages.
      this.restoreEllipsoid(
        'error',
        '地形服务连接失败，已使用椭球面。请检查访问凭据、权限和网络后重试。',
      );
    }
  }

  private restoreEllipsoid(status: TerrainStatus, error?: string) {
    this.viewer.terrainProvider = new EllipsoidTerrainProvider();
    this.clearSelection();
    this.emit({ terrainStatus: status, terrainError: error, pointer: null });
    this.viewer.scene.requestRender();
  }

  destroy() {
    if (this.disposed) return;
    this.disposed = true;
    ++this.terrainRequestId;
    this.removeTerrainErrorListener?.();
    this.disposers.forEach((dispose) => dispose());
    this.input.destroy();
    this.viewer.destroy();
  }
}
