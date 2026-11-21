import {
  ArcType, Cartesian2, Cartesian3, ClassificationType, Color, CustomDataSource, Entity,
  HeightReference, HorizontalOrigin, LabelStyle, PolylineDashMaterialProperty, VerticalOrigin,
} from 'cesium';
import type { EntityCollection, Viewer } from 'cesium';
import { formatDistance, geodesicMidpoint, geodesicPath, measureDistance } from './distance';
import type { MapAnnotation, WorkspaceOverlay, WorkspaceVertex } from './types';

const markerBlue = Color.fromCssColorString('#0087ff');
const markerOrange = Color.fromCssColorString('#ffac71');
const lineYellow = Color.fromCssColorString('#ffda38');
const textBackground = Color.fromCssColorString('#071727');
const groundHeight = HeightReference.CLAMP_TO_TERRAIN;

function position(point: WorkspaceVertex) {
  return Cartesian3.fromDegrees(point.longitude, point.latitude);
}

function samePosition(first: WorkspaceVertex, second: WorkspaceVertex) {
  return first.longitude === second.longitude && first.latitude === second.latitude;
}

function updateEntities(entities: EntityCollection, render: () => void) {
  entities.suspendEvents();
  try {
    entities.removeAll();
    render();
  } finally {
    entities.resumeEvents();
  }
}

function annotationVertex(annotation: MapAnnotation): WorkspaceVertex {
  return {
    longitude: annotation.longitude,
    latitude: annotation.latitude,
    name: annotation.title,
    annotation_id: annotation.id,
    source_geoname_id: annotation.source_geoname_id,
  };
}

/** Dedicated overlays on the main Cesium Viewer. The model remains in React. */
export class WorkspaceScene {
  private readonly annotations = new CustomDataSource('workspace-annotations');
  private readonly measurements = new CustomDataSource('workspace-measurements');
  private readonly active = new CustomDataSource('workspace-active');
  private readonly preview = new CustomDataSource('workspace-preview');
  private readonly annotationPicks = new Map<Entity, WorkspaceVertex>();
  private readonly vertexPicks = new Map<Entity, WorkspaceVertex>();
  private overlay?: WorkspaceOverlay;
  private disposed = false;

  constructor(private readonly viewer: Viewer) {
    for (const source of [this.annotations, this.measurements, this.active, this.preview]) {
      void viewer.dataSources.add(source).then(added => {
        if (this.disposed && !viewer.isDestroyed()) viewer.dataSources.remove(added, true);
      });
    }
  }

  setOverlay(next: WorkspaceOverlay): WorkspaceVertex[] | undefined {
    const previous = this.overlay;
    const activePoints = next.activeMeasurement?.vertices;
    const activePointsChanged = previous?.activeMeasurement?.vertices !== activePoints;
    const selectionChanged = previous?.selectedMeasurementId !== next.selectedMeasurementId;
    const annotationsChanged = previous?.annotations !== next.annotations;
    const measurementsChanged = previous?.measurements !== next.measurements;
    const draftChanged = previous?.draftAnnotation !== next.draftAnnotation;
    const annotationSelectionChanged = previous?.selectedAnnotationId !== next.selectedAnnotationId;
    const highlightChanged = previous?.highlightedSegment !== next.highlightedSegment;
    const previewChanged = previous?.preview !== next.preview;
    this.overlay = next;

    const selected = activePoints?.length ? undefined : next.measurements.find(
      measurement => measurement.id === next.selectedMeasurementId && measurement.visible,
    );
    const active = activePoints?.length ? next.activeMeasurement : selected;
    const activeChanged = activePointsChanged || selectionChanged || measurementsChanged ||
      previous?.activeMeasurement?.segment_meters !== next.activeMeasurement?.segment_meters;

    if (annotationsChanged || annotationSelectionChanged || activeChanged) {
      this.annotationPicks.clear();
      updateEntities(this.annotations.entities, () => {
        for (const annotation of next.annotations) {
          if (!annotation.visible) continue;
          const point = annotationVertex(annotation);
          const activeLabel = active?.vertices.some(vertex =>
            vertex.name && vertex.annotation_id === annotation.id && samePosition(vertex, point),
          );
          const entity = this.addPoint(
            this.annotations.entities, point, markerOrange,
            annotation.id === next.selectedAnnotationId ? 13 : 10,
            activeLabel ? undefined : point.name,
          );
          this.annotationPicks.set(entity, point);
        }
      });
    }

    // Rebuild stable geometry only when its inputs change, not during pointer movement.
    if (measurementsChanged || selectionChanged || Boolean(previous?.activeMeasurement?.vertices.length) !== Boolean(activePoints?.length)) {
      updateEntities(this.measurements.entities, () => {
        for (const measurement of next.measurements) {
          if (!measurement.visible || measurement.id === selected?.id) continue;
          const path = measurement.vertices.slice(1).flatMap((end, i) => {
            const segment = geodesicPath(measurement.vertices[i], end);
            return i === 0 ? segment : segment.slice(1);
          });
          this.addLine(this.measurements.entities, path, 2, lineYellow.withAlpha(0.55));
        }
      });
    }

    if (activeChanged || draftChanged || highlightChanged) {
      this.vertexPicks.clear();
      updateEntities(this.active.entities, () => {
        if (next.draftAnnotation) {
          this.addPoint(this.active.entities, next.draftAnnotation, markerOrange, 13, next.draftAnnotation.name);
        }
        if (!active) return;
        for (const [index, point] of active.vertices.entries()) {
          const marker = this.addPoint(this.active.entities, point, markerBlue, 11, point.name || `点 ${index + 1}`);
          this.vertexPicks.set(marker, point);
          const end = active.vertices[index + 1];
          if (!end) continue;
          const highlighted = next.highlightedSegment === index;
          this.addLine(this.active.entities, geodesicPath(point, end), highlighted ? 5 : 3, highlighted ? Color.WHITE : lineYellow);
          const meters = active.segment_meters[index];
          if (Number.isFinite(meters)) {
            this.addDistanceLabel(this.active.entities, geodesicMidpoint(point, end), meters, highlighted);
          }
        }
      });
    }

    if (activePointsChanged || previewChanged) {
      updateEntities(this.preview.entities, () => {
        const point = next.preview;
        const start = activePoints?.at(-1);
        if (!point) return;
        this.addPoint(this.preview.entities, point, markerBlue.withAlpha(0.8), 9);
        if (!start || samePosition(point, start)) return;
        const { total_meters } = measureDistance([start, point]);
        if (total_meters === 0) return;
        this.addLine(this.preview.entities, geodesicPath(start, point), 2, lineYellow.withAlpha(0.85), true);
        this.addDistanceLabel(this.preview.entities, geodesicMidpoint(start, point), total_meters, false);
      });
    }

    this.viewer.scene.requestRender();
    if (annotationsChanged || activeChanged || draftChanged) {
      return [
        ...next.annotations.filter(annotation => annotation.visible).map(annotationVertex),
        ...(active?.vertices ?? []),
        ...(active?.vertices.slice(1).map((point, index) => geodesicMidpoint(active.vertices[index], point)) ?? []),
        ...(next.draftAnnotation ? [next.draftAnnotation] : []),
      ];
    }
  }

  pickPoint(screenPosition: Cartesian2) {
    if (this.annotationPicks.size === 0 && this.vertexPicks.size === 0) return;
    // A measurement line can overlap a marker, so look beneath the topmost picked primitive.
    let vertex: WorkspaceVertex | undefined;
    for (const hit of this.viewer.scene.drillPick(screenPosition, 6, 9, 9)) {
      const point = this.annotationPicks.get(hit.id);
      if (point) return point;
      vertex ??= this.vertexPicks.get(hit.id);
    }
    return vertex;
  }

  private addPoint(entities: EntityCollection, point: WorkspaceVertex, color: Color, pixelSize: number, label?: string) {
    return entities.add({
      position: position(point),
      point: { pixelSize, color, outlineColor: Color.WHITE, outlineWidth: 2, heightReference: groundHeight },
      label: label ? {
        text: label, font: '13px sans-serif', fillColor: Color.WHITE, outlineColor: textBackground,
        outlineWidth: 3, style: LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cartesian2(0, -13),
        verticalOrigin: VerticalOrigin.BOTTOM, heightReference: groundHeight,
      } : undefined,
    });
  }

  private addLine(entities: EntityCollection, path: WorkspaceVertex[], width: number, color: Color, dashed = false) {
    if (path.length < 2) return;
    entities.add({
      polyline: {
        positions: path.map(position), width,
        material: dashed ? new PolylineDashMaterialProperty({ color, dashLength: 14 }) : color,
        arcType: ArcType.GEODESIC,
        clampToGround: Entity.supportsPolylinesOnTerrain(this.viewer.scene),
        classificationType: ClassificationType.TERRAIN,
      },
    });
  }

  private addDistanceLabel(entities: EntityCollection, point: WorkspaceVertex, meters: number, highlighted: boolean) {
    entities.add({
      position: position(point),
      label: {
        text: formatDistance(meters), font: '12px sans-serif', fillColor: highlighted ? lineYellow : Color.WHITE,
        showBackground: true, backgroundColor: textBackground.withAlpha(0.9), backgroundPadding: new Cartesian2(5, 4),
        pixelOffset: new Cartesian2(7, 11), horizontalOrigin: HorizontalOrigin.LEFT,
        verticalOrigin: VerticalOrigin.TOP, heightReference: groundHeight,
      },
    });
  }

  destroy() {
    this.disposed = true;
    for (const source of [this.annotations, this.measurements, this.active, this.preview]) {
      this.viewer.dataSources.remove(source, true);
    }
    this.annotationPicks.clear();
    this.vertexPicks.clear();
  }
}
