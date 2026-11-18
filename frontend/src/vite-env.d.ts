/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CESIUM_ION_TOKEN?: string;
  readonly VITE_PROVINCE_WMS_URL?: string;
  readonly VITE_PROVINCE_WMS_LAYER?: string;
  readonly VITE_PROVINCE_WMS_STYLE?: string;
}

interface Window {
  CESIUM_BASE_URL: string;
}
