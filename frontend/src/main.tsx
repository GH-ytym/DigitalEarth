import { sceneConfig } from './config/scene';

// Configure Cesium's local resources before importing the engine.
window.CESIUM_BASE_URL = sceneConfig.cesiumBaseUrl;
void import('./bootstrap');
