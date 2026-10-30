/** Position is WGS84 degrees; camera altitude is metres above the ellipsoid. */
export const sceneConfig = {
  initialView: { longitude: 105, latitude: 28, altitude: 25_000_000 },
  globalView: { longitude: 105, latitude: 15, altitude: 32_000_000 },
  cesiumBaseUrl: `${import.meta.env.BASE_URL}cesium/`,
  imageryName: 'Natural Earth II',
  imageryDescription: 'Cesium 随附的全球低分辨率底图',
} as const;
