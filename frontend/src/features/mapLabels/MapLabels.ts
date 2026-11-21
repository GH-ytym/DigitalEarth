import {
  Cartesian2, Cartesian3, Color, Credit, HeightReference, HorizontalOrigin,
  LabelCollection, LabelStyle, SceneMode, VerticalOrigin,
} from 'cesium';
import type { Label, Viewer } from 'cesium';
import { cityLabels, marineLabels, sourceCreditHtml } from './referenceLabels';
import type { LabelScale } from './referenceLabels';

type Coordinates = { longitude: number; latitude: number };
type CityVertex = Coordinates & { name: string; source_geoname_id: string };
type ScreenBounds = { left: number; right: number; top: number; bottom: number };
type LabelEntry = {
  label: Label;
  marker?: Label;
  vertex?: CityVertex;
  maxCameraHeight: number;
  position: Cartesian3;
  normal: Cartesian3;
  screen: Cartesian2;
  width: number;
  bounds: ScreenBounds;
};

const scaleMaxHeight: Record<LabelScale, number> = {
  global: Number.POSITIVE_INFINITY,
  regional: 14_000_000,
  local: 3_500_000,
};

const cityFont = '11px "Microsoft YaHei", "Segoe UI", sans-serif';
const marineFont = '13px "Microsoft YaHei", "Segoe UI", sans-serif';
const cityColor = Color.fromCssColorString('#e5edf8');
const marineColor = Color.fromCssColorString('#65cef8');
const cityMarkerColor = Color.fromCssColorString('#e1a6a0');
const outlineColor = Color.fromCssColorString('#041221');
const cityOffset = new Cartesian2(6, 0);

function overlaps(first: ScreenBounds, second: ScreenBounds) {
  return first.left < second.right && second.left < first.right &&
    first.top < second.bottom && second.top < first.bottom;
}

/** Static reference labels are independent of saved workspace features and online imagery. */
export class MapLabels {
  private readonly collection: LabelCollection;
  private readonly entries: LabelEntry[] = [];
  private readonly credit = new Credit(sourceCreditHtml);
  private readonly removeRenderListener: () => void;
  private readonly directionToCamera = new Cartesian3();
  private readonly priorityScreen = new Cartesian2();
  private priorityPositions: Cartesian3[] = [];

  constructor(private readonly viewer: Viewer) {
    const scene = viewer.scene;
    this.collection = scene.primitives.add(new LabelCollection({ scene }));
    const metrics = document.createElement('canvas').getContext('2d');
    const priorities: LabelScale[] = ['global', 'regional', 'local'];
    for (const level of priorities) {
      for (const [, name, longitude, latitude, scale] of marineLabels) {
        if (scale !== level) continue;
        this.entries.push(this.addEntry(name, longitude, latitude, scale, metrics));
      }
      for (const [id, name, longitude, latitude, scale] of cityLabels) {
        if (scale !== level) continue;
        const vertex = { name, longitude, latitude, source_geoname_id: id };
        this.entries.push(this.addEntry(name, longitude, latitude, scale, metrics, vertex));
      }
    }
    viewer.creditDisplay.addStaticCredit(this.credit);
    this.removeRenderListener = scene.preRender.addEventListener(() => this.layout());
    scene.requestRender();
  }

  setVisible(visible: boolean) {
    if (this.collection.show === visible) return;
    this.collection.show = visible;
    if (visible) {
      this.viewer.creditDisplay.addStaticCredit(this.credit);
    } else {
      this.viewer.creditDisplay.removeStaticCredit(this.credit);
      for (const entry of this.entries) this.setEntryVisibility(entry, false);
    }
    this.viewer.scene.requestRender();
  }

  setPriorityPoints(points: readonly Coordinates[]) {
    const ellipsoid = this.viewer.scene.globe.ellipsoid;
    this.priorityPositions = points.map(point =>
      Cartesian3.fromDegrees(point.longitude, point.latitude, 0, ellipsoid),
    );
    this.viewer.scene.requestRender();
  }

  pickVertex(position: Cartesian2): CityVertex | undefined {
    if (!this.collection.show) return undefined;
    let match: CityVertex | undefined;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const entry of this.entries) {
      if (!entry.vertex || !entry.label.show) continue;
      const distance = Cartesian2.distanceSquared(position, entry.screen);
      const { left, right, top, bottom } = entry.bounds;
      const inLabel = position.x >= left && position.x <= right && position.y >= top && position.y <= bottom;
      if ((distance <= 10 ** 2 || inLabel) && distance < nearestDistance) {
        nearestDistance = distance;
        match = entry.vertex;
      }
    }
    return match && { ...match };
  }

  destroy() {
    this.removeRenderListener();
    if (this.collection.show) this.viewer.creditDisplay.removeStaticCredit(this.credit);
    this.viewer.scene.primitives.remove(this.collection);
  }

  private addEntry(
    name: string, longitude: number, latitude: number, scale: LabelScale,
    metrics: CanvasRenderingContext2D | null, vertex?: CityVertex,
  ): LabelEntry {
    const ellipsoid = this.viewer.scene.globe.ellipsoid;
    const position = Cartesian3.fromDegrees(longitude, latitude, 0, ellipsoid);
    const font = vertex ? cityFont : marineFont;
    const common = {
      position,
      show: false,
      heightReference: HeightReference.CLAMP_TO_TERRAIN,
      verticalOrigin: VerticalOrigin.CENTER,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      style: LabelStyle.FILL_AND_OUTLINE,
      outlineColor,
    };
    const label = this.collection.add({
      ...common,
      text: name,
      font,
      fillColor: vertex ? cityColor : marineColor,
      outlineWidth: 2,
      horizontalOrigin: vertex ? HorizontalOrigin.LEFT : HorizontalOrigin.CENTER,
      pixelOffset: vertex ? cityOffset : Cartesian2.ZERO,
    });
    const marker = vertex ? this.collection.add({
      ...common,
      text: '•',
      font: cityFont,
      fillColor: cityMarkerColor,
      outlineWidth: 1,
      horizontalOrigin: HorizontalOrigin.CENTER,
    }) : undefined;
    if (metrics) metrics.font = font;
    return {
      label, marker, vertex, position,
      maxCameraHeight: scaleMaxHeight[scale],
      normal: ellipsoid.geodeticSurfaceNormal(position),
      screen: new Cartesian2(),
      width: metrics?.measureText(name).width ?? name.length * 13,
      bounds: { left: 0, right: 0, top: 0, bottom: 0 },
    };
  }

  private setEntryVisibility(entry: LabelEntry, visible: boolean) {
    entry.label.show = visible;
    if (entry.marker) entry.marker.show = visible;
  }

  private layout() {
    if (!this.collection.show) return;
    const { scene, camera } = this.viewer;
    if (scene.mode === SceneMode.MORPHING) {
      for (const entry of this.entries) this.setEntryVisibility(entry, false);
      return;
    }
    const { clientWidth, clientHeight } = scene.canvas;
    const showLimit = Math.max(16, Math.min(64, Math.floor(clientWidth * clientHeight / 14_000)));
    const altitude = camera.positionCartographic.height;
    const cameraPosition = camera.positionWC;
    const is3D = scene.mode === SceneMode.SCENE3D;
    const occupied: ScreenBounds[] = [];
    for (const point of this.priorityPositions) {
      const screen = scene.cartesianToCanvasCoordinates(point, this.priorityScreen);
      if (!screen) continue;
      if (screen.x < -110 || screen.x > clientWidth + 16 ||
        screen.y < -28 || screen.y > clientHeight + 28) continue;
      occupied.push({ left: screen.x - 14, right: screen.x + 105, top: screen.y - 24, bottom: screen.y + 16 });
    }
    let visibleCount = 0;
    for (const entry of this.entries) {
      const relevant = altitude <= entry.maxCameraHeight && visibleCount < showLimit;
      if (!relevant || (is3D && !this.facingCamera(cameraPosition, entry))) {
        this.setEntryVisibility(entry, false);
        continue;
      }
      const screen = (entry.marker ?? entry.label).computeScreenSpacePosition(scene, entry.screen);
      if (!screen || !Number.isFinite(screen.x) || !Number.isFinite(screen.y) ||
        screen.x < 0 || screen.x > clientWidth || screen.y < 0 || screen.y > clientHeight) {
        this.setEntryVisibility(entry, false);
        continue;
      }
      const { bounds, width, vertex } = entry;
      bounds.left = screen.x - (vertex ? 5 : width / 2 + 3);
      bounds.right = screen.x + (vertex ? width + cityOffset.x + 4 : width / 2 + 3);
      bounds.top = screen.y - 9;
      bounds.bottom = screen.y + 9;
      const visible = !occupied.some(other => overlaps(bounds, other));
      this.setEntryVisibility(entry, visible);
      if (visible) {
        occupied.push(bounds);
        visibleCount++;
      }
    }
  }

  private facingCamera(cameraPosition: Cartesian3, entry: LabelEntry) {
    Cartesian3.subtract(cameraPosition, entry.position, this.directionToCamera);
    return Cartesian3.dot(entry.normal, this.directionToCamera) > 0;
  }
}
