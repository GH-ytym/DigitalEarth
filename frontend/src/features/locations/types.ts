export const placeKinds = ['country', 'admin1', 'admin2', 'admin3', 'admin4', 'admin5', 'city'] as const;

export interface PlaceResult {
  geoname_id: number;
  name: string;
  canonical_name: string;
  kind: typeof placeKinds[number];
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
  return [place.canonical_name, place.kind !== 'admin1' ? place.admin1_name : null, place.country_name]
    .filter(Boolean).join(' · ');
}

export function placeKindLabel(place: PlaceResult): string {
  if (place.kind === 'country') return '国家/地区';
  const adminLabels = { admin1: '一级行政区', admin2: '二级行政区', admin3: '三级行政区', admin4: '四级行政区', admin5: '五级行政区' };
  if (place.kind in adminLabels) return adminLabels[place.kind as keyof typeof adminLabels];
  if (place.feature_code === 'PPLC') return '首都居民点';
  if (place.feature_code.startsWith('PPLA')) return '行政驻地';
  return '居民点';
}

export function placeCameraHeight(place: PlaceResult): number {
  return { country: 6_000_000, admin1: 1_200_000, admin2: 400_000, admin3: 150_000, admin4: 60_000, admin5: 30_000, city: 120_000 }[place.kind];
}
