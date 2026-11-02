/** Position is WGS84 degrees; camera altitude is metres above the ellipsoid. */
export const sceneConfig = {
  initialView: { longitude: 105, latitude: 28, altitude: 25_000_000 },
  globalView: { longitude: 105, latitude: 15, altitude: 32_000_000 },
  cesiumBaseUrl: `${import.meta.env.BASE_URL}cesium/`,
  imageryName: '全球卫星影像',
  imageryDescription: 'Cesium World Imagery',
  ionToken: import.meta.env.VITE_CESIUM_ION_TOKEN?.trim() ?? '',
} as const;
