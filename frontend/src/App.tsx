import { useCallback, useRef, useState } from 'react';
import { Icon } from './components/Icon';
import type { IconName } from './components/Icon';
import { GlobeViewport } from './features/globe/GlobeViewport';
import type { SceneController } from './features/globe/SceneController';
import { initialSnapshot } from './features/globe/types';
import type { BasemapName, SceneSnapshot, TerrainStatus } from './features/globe/types';
import { QueryPanel } from './features/locations/QueryPanel';

type Panel = 'layers' | 'query';
const navigation: Array<{ id: Panel; label: string; icon: IconName }> = [
  { id: 'layers', label: '图层管理', icon: 'layers' },
  { id: 'query', label: '查询索引', icon: 'locate' },
];
const panelTitles = { layers: '图层管理', query: '查询索引' };
const terrainLabels: Record<TerrainStatus, string> = {
  unconfigured: '未配置',
  disabled: '已关闭',
  loading: '加载中',
  ready: '可用',
  error: '加载失败',
};

function formatHeight(height: number) {
  return Math.abs(height) >= 1000
    ? `${(height / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })} km`
    : `${height.toFixed(1)} m`;
}
function coordinate(value: number, positive: string, negative: string) {
  return `${Math.abs(value).toFixed(4)}° ${value >= 0 ? positive : negative}`;
}
function surfaceHeight(height: number | null) {
  return height === null ? '待加载' : `${height.toFixed(1)} m`;
}

export default function App() {
  const controller = useRef<SceneController | null>(null);
  const [scene, setScene] = useState<SceneSnapshot>(initialSnapshot);
  const [panel, setPanel] = useState<Panel | null>('layers');
  const [basemap, setBasemap] = useState<BasemapName>('natural');
  const [grid, setGrid] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const onReady = useCallback((value: SceneController | null) => {
    controller.current = value;
  }, []);
  const onSnapshot = useCallback((value: SceneSnapshot) => setScene(value), []);
  const onError = useCallback(
    (error: string) => setScene((previous) => ({ ...previous, status: 'error', error })),
    [],
  );
  const initialized = scene.status !== 'loading' && !scene.transitioning;
  const terrainActive = scene.terrainStatus === 'ready';
  const terrainBusy = scene.terrainStatus === 'loading';
  const terrainName = terrainActive ? '全球高程地形' : 'WGS84 椭球面';

  function changeBasemap(value: BasemapName) {
    setBasemap(value);
    controller.current?.setBasemap(value);
  }
  function togglePanel(value: Panel) {
    setPanel((current) => (current === value ? null : value));
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="./" aria-label="DigitalEarth 首页">
          <span className="brand-symbol">
            <Icon name="orbit" size={28} />
          </span>
          <span>
            DigitalEarth<small>数字地球仿真展示</small>
          </span>
        </a>
        <div className="header-divider" />
        <div className="breadcrumb">
          <span>工作空间</span>
          <Icon name="chevron" size={12} />
          <strong>数字地球</strong>
        </div>
        <span className="version">V0.1</span>
      </header>

      <main className="workspace">
        <GlobeViewport onReady={onReady} onSnapshot={onSnapshot} onError={onError} />
        <nav className="navigation" aria-label="工作区功能">
          {navigation.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${panel === item.id ? 'active' : ''}`}
              onClick={() => togglePanel(item.id)}
              aria-pressed={panel === item.id}
              title={item.label}
            >
              <Icon name={item.icon} size={22} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="scene-heading">
          <span className="eyebrow">DIGITAL EARTH WORKSPACE</span>
          <h1>
            三维场景<span>/</span>
            <small>基础地球</small>
          </h1>
        </div>

        {panel && (
          <aside className="floating-panel main-panel" aria-label={panelTitles[panel]}>
            <div className="panel-header">
              <div>
                <Icon name={panel === 'layers' ? 'layers' : 'locate'} size={18} />
                <h2>{panelTitles[panel]}</h2>
              </div>
              <button className="icon-button" aria-label="收起面板" onClick={() => setPanel(null)}>
                <Icon name="close" size={16} />
              </button>
            </div>
            <div className="panel-content">
              {panel === 'layers' && (
                <>
                  <p className="panel-description">管理地球底图、地形与辅助图层。</p>
                  <h3 className="section-title">
                    基础底图<span className="tag">本地资源</span>
                  </h3>
                  <div className="basemap-list" role="radiogroup" aria-label="基础底图">
                    <button
                      role="radio"
                      aria-checked={basemap === 'natural'}
                      className={`basemap-card ${basemap === 'natural' ? 'selected' : ''}`}
                      onClick={() => changeBasemap('natural')}
                    >
                      <span className="map-thumbnail">
                        <Icon name="globe" size={29} />
                      </span>
                      <span className="basemap-text">
                        <strong>全球自然地理</strong>
                        <small>Natural Earth II</small>
                      </span>
                      <span className="radio-indicator">{basemap === 'natural' && <span />}</span>
                    </button>
                    <button
                      role="radio"
                      aria-checked={basemap === 'plain'}
                      className={`basemap-card ${basemap === 'plain' ? 'selected' : ''}`}
                      onClick={() => changeBasemap('plain')}
                    >
                      <span className="map-thumbnail">
                        <Icon name="globe" size={29} />
                      </span>
                      <span className="basemap-text">
                        <strong>纯色地球</strong>
                        <small>WGS84 椭球</small>
                      </span>
                      <span className="radio-indicator">{basemap === 'plain' && <span />}</span>
                    </button>
                  </div>
                  <div className="resource-detail">
                    <span className="resource-dot" />
                    低分辨率底图 · 本地加载
                  </div>
                  <div className="panel-divider" />
                  <h3 className="section-title">
                    地形资源<span className="tag">{terrainLabels[scene.terrainStatus]}</span>
                  </h3>
                  <label className="toggle-row">
                    <span>
                      <Icon name="globe" size={17} />
                      真实地形
                    </span>
                    <input
                      type="checkbox"
                      role="switch"
                      checked={terrainActive || terrainBusy}
                      disabled={scene.terrainStatus === 'unconfigured'}
                      onChange={(e) => void controller.current?.setTerrainEnabled(e.target.checked)}
                    />
                    <span className="switch-track" />
                  </label>
                  <p className="quiet-description terrain-description" role="status">
                    {scene.terrainStatus === 'unconfigured' &&
                      '未配置地形服务，当前使用 WGS84 椭球面。'}
                    {scene.terrainStatus === 'disabled' &&
                      '真实地形已关闭，当前使用 WGS84 椭球面。'}
                    {terrainBusy && '正在连接地形服务，完成后显示真实高程起伏。'}
                    {terrainActive && 'Cesium World Terrain · 高度采用 WGS84 椭球高。'}
                    {scene.terrainStatus === 'error' && scene.terrainError}
                  </p>
                  {scene.terrainStatus === 'error' && (
                    <button
                      className="text-button"
                      onClick={() => void controller.current?.setTerrainEnabled(true)}
                    >
                      重试加载
                      <Icon name="arrow" size={15} />
                    </button>
                  )}
                  <div className="panel-divider" />
                  <h3 className="section-title">辅助图层</h3>
                  <label className="toggle-row">
                    <span>
                      <Icon name="grid" size={17} />
                      网格辅助线
                    </span>
                    <input
                      type="checkbox"
                      role="switch"
                      checked={grid}
                      onChange={(e) => {
                        setGrid(e.target.checked);
                        controller.current?.setGrid(e.target.checked);
                      }}
                    />
                    <span className="switch-track" />
                  </label>
                </>
              )}
              {panel === 'query' && (
                <QueryPanel
                  onLocate={(lon, lat, altitude) => controller.current?.locate(lon, lat, altitude)}
                  disabled={!initialized}
                />
              )}
            </div>
            <div className="panel-footer">
              <span className="resource-dot" />
              {scene.status === 'ready'
                ? '场景就绪'
                : scene.status === 'loading'
                  ? '场景初始化中'
                  : '场景异常'}
              <span>{scene.mode}</span>
            </div>
          </aside>
        )}

        {inspectorOpen && (
          <aside className="floating-panel inspector" aria-label="场景信息">
            <div className="panel-header">
              <div>
                <Icon name="pin" size={17} />
                <h2>{scene.selection ? '选中位置' : '场景信息'}</h2>
              </div>
              <button
                className="icon-button"
                aria-label="收起场景信息"
                onClick={() => setInspectorOpen(false)}
              >
                <Icon name="close" size={15} />
              </button>
            </div>
            <div className="inspector-content">
              <span className="inspector-label">
                {scene.selection ? 'SURFACE COORDINATES' : 'CAMERA & REFERENCE'}
              </span>
              {scene.selection ? (
                <dl>
                  <div>
                    <dt>经度</dt>
                    <dd>{coordinate(scene.selection.longitude, 'E', 'W')}</dd>
                  </div>
                  <div>
                    <dt>纬度</dt>
                    <dd>{coordinate(scene.selection.latitude, 'N', 'S')}</dd>
                  </div>
                  <div>
                    <dt>椭球高</dt>
                    <dd>{surfaceHeight(scene.selection.height)}</dd>
                  </div>
                  <div>
                    <dt>坐标基准</dt>
                    <dd>WGS84</dd>
                  </div>
                </dl>
              ) : (
                <dl>
                  <div>
                    <dt>视角高度</dt>
                    <dd>{formatHeight(scene.cameraHeight)}</dd>
                  </div>
                  <div>
                    <dt>空间参考</dt>
                    <dd>WGS84</dd>
                  </div>
                  <div>
                    <dt>地形资源</dt>
                    <dd>{terrainName}</dd>
                  </div>
                  <div>
                    <dt>场景模式</dt>
                    <dd>{scene.mode}</dd>
                  </div>
                </dl>
              )}
              {scene.selection ? (
                <button
                  className="text-button"
                  onClick={() => controller.current?.clearSelection()}
                >
                  清除选中位置
                  <Icon name="close" size={13} />
                </button>
              ) : (
                <p className="inspector-hint">点击地球，查看地表坐标</p>
              )}
            </div>
          </aside>
        )}

        <div className="map-controls" aria-label="地图控制">
          <button
            className="compass"
            aria-label="指北复位"
            title="指北复位"
            onClick={() => controller.current?.northUp()}
            disabled={!initialized}
          >
            <span className="compass-letter">N</span>
            <span className="compass-needle" style={{ transform: `rotate(${-scene.heading}deg)` }}>
              ▲
            </span>
          </button>
          <div className="control-group">
            <button
              aria-label="放大"
              title="放大"
              onClick={() => controller.current?.zoom('in')}
              disabled={!initialized}
            >
              <Icon name="plus" />
            </button>
            <button
              aria-label="缩小"
              title="缩小"
              onClick={() => controller.current?.zoom('out')}
              disabled={!initialized}
            >
              <Icon name="minus" />
            </button>
          </div>
          <div className="control-group">
            <button
              className={scene.mode === '3D' ? 'selected' : ''}
              aria-label="三维视图"
              aria-pressed={scene.mode === '3D'}
              onClick={() => controller.current?.setMode('3D')}
              disabled={!initialized}
            >
              3D
            </button>
            <button
              className={scene.mode === '2D' ? 'selected' : ''}
              aria-label="二维视图"
              aria-pressed={scene.mode === '2D'}
              onClick={() => controller.current?.setMode('2D')}
              disabled={!initialized}
            >
              2D
            </button>
          </div>
          <div className="control-group">
            <button
              aria-label="初始视角"
              title="初始视角"
              onClick={() => controller.current?.home()}
              disabled={!initialized}
            >
              <Icon name="home" />
            </button>
            <button
              aria-label="全球视角"
              title="全球视角"
              onClick={() => controller.current?.globalView()}
              disabled={!initialized}
            >
              <Icon name="globe" />
            </button>
            <button
              aria-label="显示场景信息"
              aria-pressed={inspectorOpen}
              title="场景信息"
              onClick={() => setInspectorOpen((value) => !value)}
            >
              <Icon name="info" />
            </button>
          </div>
        </div>

        <div className="mouse-hint">
          <Icon name="mouse" size={14} />
          <span>
            拖动浏览<span className="hint-dot">·</span>滚轮缩放<span className="hint-dot">·</span>
            单击拾取
          </span>
        </div>
        {scene.status === 'loading' && (
          <div className="scene-message" role="status">
            <span className="loading-ring" />
            正在准备三维场景与本地底图…
          </div>
        )}
        {scene.status === 'error' && (
          <div className="scene-error" role="alert">
            <Icon name="info" />
            <div>
              <strong>场景资源加载异常</strong>
              <p>{scene.error}</p>
              <p>请检查浏览器 WebGL 支持和静态资源路径。</p>
            </div>
            <button onClick={() => window.location.reload()}>重新加载</button>
          </div>
        )}
      </main>

      <footer className="statusbar">
        <div className="scene-status">
          <span className="status-dot" />
          {scene.status === 'ready'
            ? '场景就绪'
            : scene.status === 'loading'
              ? '初始化中'
              : '资源异常'}
        </div>
        <span className="status-separator" />
        <div className="pointer-values">
          <span>
            经度 <b>{scene.pointer ? coordinate(scene.pointer.longitude, 'E', 'W') : '—'}</b>
          </span>
          <span>
            纬度 <b>{scene.pointer ? coordinate(scene.pointer.latitude, 'N', 'S') : '—'}</b>
          </span>
          <span className="pointer-height">
            椭球高 <b>{scene.pointer ? surfaceHeight(scene.pointer.height) : '—'}</b>
          </span>
        </div>
        <div className="status-right">
          <span>
            视角高度 <b>{formatHeight(scene.cameraHeight)}</b>
          </span>
          <span className="status-separator" />
          <span>WGS84</span>
          <span className="status-mode">{scene.mode}</span>
        </div>
      </footer>
    </div>
  );
}
