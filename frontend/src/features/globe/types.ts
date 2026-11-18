import type { PlaceResult } from '../locations/types';
import { defaultProvinceSettings } from '../layers/provinceSettings';
import type { ProvinceSettings } from '../layers/provinceSettings';

export type SceneModeName = '3D' | '2D';
export type TerrainStatus = 'unconfigured' | 'disabled' | 'loading' | 'ready' | 'error';
export type MapLayerStatus = 'disabled' | 'loading' | 'ready' | 'error';
export interface GeoPosition {
  longitude: number;
  latitude: number;
  height: number | null;
}
export interface SelectedPosition extends GeoPosition {
  place?: PlaceResult;
}
export interface SceneSnapshot {
  status: 'loading' | 'ready' | 'error';
  error?: string;
  cameraHeight: number;
  heading: number;
  mode: SceneModeName;
  transitioning: boolean;
  pointer: GeoPosition | null;
  selection: SelectedPosition | null;
  terrainStatus: TerrainStatus;
  terrainError?: string;
  provinceStatus: MapLayerStatus;
  provinceError?: string;
  provinceSettings: ProvinceSettings;
  provinceSettingsSaved?: boolean;
}
export const initialSnapshot: SceneSnapshot = {
  status: 'loading',
  cameraHeight: 25_000_000,
  heading: 0,
  mode: '3D',
  transitioning: false,
  pointer: null,
  selection: null,
  terrainStatus: 'unconfigured',
  provinceStatus: 'disabled',
  provinceSettings: { ...defaultProvinceSettings },
};
