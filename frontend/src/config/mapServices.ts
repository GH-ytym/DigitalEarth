export const provinceBoundary = {
  name: '中国省级行政区界线',
  url: import.meta.env.VITE_PROVINCE_WMS_URL?.trim() || '/geoserver/China/wms',
  layer: import.meta.env.VITE_PROVINCE_WMS_LAYER?.trim() || 'China:中国省级行政区',
  style: import.meta.env.VITE_PROVINCE_WMS_STYLE?.trim() || 'China:province_outline_dynamic',
  bounds: { west: 73.498962, south: 3.832541, east: 135.087387, north: 53.558498 },
} as const;
