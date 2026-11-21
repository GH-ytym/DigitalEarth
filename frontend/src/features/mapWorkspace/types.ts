export interface WorkspaceVertex {
  longitude: number;
  latitude: number;
  name?: string;
  annotation_id?: string;
  source_geoname_id?: string;
}

interface WorkspaceRecordInput {
  id?: string;
  title: string;
  note: string;
  visible: boolean;
}

export interface AnnotationInput extends WorkspaceRecordInput {
  longitude: number;
  latitude: number;
  source_geoname_id?: string;
}

interface SavedRecord {
  id: string;
  created_at: string;
  updated_at: string;
}

export interface MapAnnotation extends Omit<AnnotationInput, 'id'>, SavedRecord {}

export type MeasurementMode = 'straight' | 'polyline';

export interface MeasurementInput extends WorkspaceRecordInput {
  mode: MeasurementMode;
  vertices: WorkspaceVertex[];
}

export interface SegmentDistances {
  segment_meters: number[];
  total_meters: number;
}

export interface DistanceMeasurement extends Omit<MeasurementInput, 'id'>, SegmentDistances, SavedRecord {
  algorithm: string;
}

export interface WorkspaceInput {
  onPick: (vertex: WorkspaceVertex) => void;
  onHover: (vertex: WorkspaceVertex | null) => void;
}

export interface WorkspaceOverlay {
  annotations: MapAnnotation[];
  measurements: DistanceMeasurement[];
  activeMeasurement?: Pick<DistanceMeasurement, 'vertices' | 'segment_meters'>;
  preview?: WorkspaceVertex | null;
  highlightedSegment?: number | null;
  selectedAnnotationId?: string | null;
  draftAnnotation?: WorkspaceVertex | null;
  selectedMeasurementId?: string | null;
}
