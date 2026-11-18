import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import { provinceBoundary } from '../../config/mapServices';
import type { MapLayerStatus } from '../globe/types';
import { provinceLineWidths } from './provinceSettings';
import type { ProvinceSettings } from './provinceSettings';

interface Props {
  settings: ProvinceSettings;
  status: MapLayerStatus;
  error?: string;
  saved?: boolean;
  canLocate: boolean;
  onChange: (patch: Partial<ProvinceSettings>) => void;
  onLocate: () => void;
  onRetry: () => void;
  onReset: () => void;
  onClose: () => void;
}

const statusLabels: Record<MapLayerStatus, string> = {
  disabled: '已关闭', loading: '加载中', ready: '可用', error: '加载失败',
};

export function LayerPropertiesPanel(props: Props) {
  const { settings, status, saved } = props;
  const [colorText, setColorText] = useState(settings.lineColor);
  const [showResource, setShowResource] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  const validColor = /^#[0-9a-f]{6}$/i.test(colorText);
  useEffect(() => setColorText(settings.lineColor), [settings.lineColor]);
  useEffect(() => closeButton.current?.focus(), []);

  return (
    <aside
      className="floating-panel layer-properties"
      aria-label="图层属性"
      onKeyDown={(event) => {
        if (event.key === 'Escape') props.onClose();
      }}
    >
      <div className="panel-header">
        <div><Icon name="layers" size={18} /><h2>图层属性</h2></div>
        <button ref={closeButton} className="icon-button" aria-label="关闭图层属性" onClick={props.onClose}>
          <Icon name="close" size={16} />
        </button>
      </div>
      <div className="panel-content">
        <div className="layer-property-title">
          <strong>{provinceBoundary.name}</strong>
          <span className={`layer-availability ${status}`} role="status">
            <span />{statusLabels[status]}
          </span>
        </div>
        <div className="property-fields">
          <div className="property-row">
            <label htmlFor="province-opacity">不透明度</label>
            <div className="opacity-control">
              <input
                id="province-opacity" type="range" min="0" max="100" step="1"
                value={Math.round(settings.opacity * 100)}
                aria-valuetext={`${Math.round(settings.opacity * 100)}%`}
                onChange={(event) => props.onChange({ opacity: Number(event.target.value) / 100 })}
              />
              <output htmlFor="province-opacity">{Math.round(settings.opacity * 100)}%</output>
            </div>
          </div>
          <div className="property-row">
            <label htmlFor="province-line-color">线色</label>
            <div className="color-control">
              <input
                type="color" aria-label="选择省界线色" value={settings.lineColor}
                onChange={(event) => props.onChange({ lineColor: event.target.value })}
              />
              <input
                id="province-line-color" type="text" value={colorText} maxLength={7}
                spellCheck={false} aria-invalid={!validColor} aria-describedby={!validColor ? 'color-format-hint' : undefined}
                onChange={(event) => {
                  const color = event.target.value.toUpperCase();
                  setColorText(color);
                  if (/^#[0-9a-f]{6}$/i.test(color)) props.onChange({ lineColor: color });
                }}
              />
            </div>
          </div>
          {!validColor && <p className="property-hint" id="color-format-hint">请输入 # 加六位颜色值，例如 #00DDEB。</p>}
          <div className="property-row">
            <label htmlFor="province-line-width">线宽</label>
            <select
              id="province-line-width" value={settings.lineWidth}
              onChange={(event) => props.onChange({ lineWidth: Number(event.target.value) })}
            >
              {provinceLineWidths.map((width) => <option key={width} value={width}>{width} px</option>)}
            </select>
          </div>
          <div className="property-row">
            <span>叠加顺序</span>
            <div className="layer-order-controls">
              <button disabled title="当前仅有一个业务图层"><Icon name="up" size={14} />上移</button>
              <button disabled title="当前仅有一个业务图层"><Icon name="down" size={14} />下移</button>
            </div>
          </div>
          <p className="property-hint">当前仅有一个业务图层，卫星底图固定在底部。</p>
        </div>
        {status === 'error' && (
          <div className="property-error" role="alert">
            <p>{props.error}</p>
            <button className="text-button" onClick={props.onRetry}>重试加载<Icon name="arrow" size={14} /></button>
          </div>
        )}
        <div className="property-actions">
          <button className="primary" onClick={props.onLocate} disabled={!props.canLocate}>
            <Icon name="locate" size={16} />定位范围
          </button>
          <button aria-expanded={showResource} aria-controls="province-resource-info" onClick={() => setShowResource(!showResource)}>
            <Icon name="info" size={16} />资源信息
          </button>
        </div>
        {showResource && (
          <dl className="layer-resource-info" id="province-resource-info">
            <div><dt>服务类型</dt><dd>GeoServer WMS 1.1.1</dd></div>
            <div><dt>服务地址</dt><dd>{provinceBoundary.url}</dd></div>
            <div><dt>图层名称</dt><dd>{provinceBoundary.layer}</dd></div>
            <div><dt>输出坐标系</dt><dd>EPSG:4326</dd></div>
          </dl>
        )}
        <div className="property-save-status" role="status">
          {saved === false ? '浏览器未能保存设置；当前调整仍有效。' : saved ? '已自动保存到此浏览器' : '设置自动保存在此浏览器，刷新后恢复。'}
        </div>
        <button className="text-button property-reset" onClick={() => {
          setColorText('#000000');
          props.onReset();
        }}>恢复默认设置</button>
      </div>
    </aside>
  );
}
