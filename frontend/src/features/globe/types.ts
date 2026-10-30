export type SceneModeName = '3D' | '2D';
export type BasemapName = 'natural' | 'plain';
export interface GeoPosition {
  longitude: number;
  latitude: number;
  height: number;
}
export interface SceneSnapshot {
  status: 'loading' | 'ready' | 'error';
  error?: string;
  cameraHeight: number;
  heading: number;
  mode: SceneModeName;
  transitioning: boolean;
  pointer: GeoPosition | null;
  selection: GeoPosition | null;
}
export const initialSnapshot: SceneSnapshot = {
  status: 'loading',
  cameraHeight: 25_000_000,
  heading: 0,
  mode: '3D',
  transitioning: false,
  pointer: null,
  selection: null,
};
