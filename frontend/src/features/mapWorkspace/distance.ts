import geographiclib from 'geographiclib-geodesic';
import type { SegmentDistances, WorkspaceVertex } from './types.ts';

const wgs84 = geographiclib.Geodesic.WGS84;

export function measureDistance(vertices: readonly WorkspaceVertex[]): SegmentDistances {
  const segments = vertices.slice(1).map((end, index) => {
    const start = vertices[index];
    return wgs84.Inverse(start.latitude, start.longitude, end.latitude, end.longitude).s12!;
  });
  return { segment_meters: segments, total_meters: segments.reduce((sum, segment) => sum + segment, 0) };
}

function geodesicLine(start: WorkspaceVertex, end: WorkspaceVertex) {
  return wgs84.InverseLine(start.latitude, start.longitude, end.latitude, end.longitude);
}

export function geodesicPath(start: WorkspaceVertex, end: WorkspaceVertex): WorkspaceVertex[] {
  const line = geodesicLine(start, end);
  // Short subarcs let the renderer follow the same branch, including near antipodes.
  const count = Math.max(1, Math.ceil(line.s13 / 100_000));
  const intermediate = Array.from({ length: count - 1 }, (_, index) => {
    const point = line.Position(line.s13 * (index + 1) / count);
    return { longitude: point.lon2!, latitude: point.lat2! };
  });
  return [start, ...intermediate, end];
}

export function geodesicMidpoint(start: WorkspaceVertex, end: WorkspaceVertex): WorkspaceVertex {
  const line = geodesicLine(start, end);
  const point = line.Position(line.s13 / 2);
  return { longitude: point.lon2!, latitude: point.lat2! };
}

const metersFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const kilometersFormat = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatDistance(meters: number): string {
  return meters < 1000
    ? `${metersFormat.format(meters)} m`
    : `${kilometersFormat.format(meters / 1000)} km`;
}
