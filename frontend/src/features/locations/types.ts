export interface PlaceResult {
  geoname_id: number;
  name: string;
  canonical_name: string;
  kind: 'country' | 'admin1' | 'city';
  country_code: string;
  country_name: string;
  admin1_code: string | null;
  admin1_name: string | null;
  feature_code: string;
  longitude: number;
  latitude: number;
  approximate_representative_point: boolean;
}

export function placeHierarchy(place: PlaceResult): string {
  if (place.kind === 'country') return place.canonical_name;
  return [place.canonical_name, place.kind === 'city' ? place.admin1_name : null, place.country_name]
    .filter(Boolean).join(' · ');
}

export function placeKindLabel(place: PlaceResult): string {
  if (place.kind === 'country') return '国家/地区';
  if (place.kind === 'admin1') return '一级行政区';
  if (place.feature_code === 'PPLC') return '首都居民点';
  if (place.feature_code.startsWith('PPLA')) return '行政驻地';
  return '居民点';
}

export function placeCameraHeight(place: PlaceResult): number {
  return { country: 6_000_000, admin1: 1_200_000, city: 120_000 }[place.kind];
}
