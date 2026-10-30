import { useState } from 'react';
import { Icon } from '../../components/Icon';
import { CoordinatePanel } from './CoordinatePanel';

interface Props {
  onLocate: (longitude: number, latitude: number, altitude: number) => void;
  disabled: boolean;
}

export function QueryPanel({ onLocate, disabled }: Props) {
  const [tab, setTab] = useState<'places' | 'coordinates'>('coordinates');

  return (
    <>
      <div className="query-tabs" role="tablist" aria-label="查询方式">
        <button
          id="places-tab"
          role="tab"
          aria-selected={tab === 'places'}
          aria-controls="places-panel"
          onClick={() => setTab('places')}
        >
          地名查询
        </button>
        <button
          id="coordinates-tab"
          role="tab"
          aria-selected={tab === 'coordinates'}
          aria-controls="coordinates-panel"
          onClick={() => setTab('coordinates')}
        >
          坐标定位
        </button>
      </div>
      <section
        id="places-panel"
        role="tabpanel"
        aria-labelledby="places-tab"
        hidden={tab !== 'places'}
      >
        <div className="query-empty">
          <Icon name="locate" size={30} />
          <h3>地名查询尚未接入</h3>
          <p>接入地名服务后，可按名称检索地点并在地球中定位。</p>
          <button className="primary-button" onClick={() => setTab('coordinates')}>
            使用坐标定位
            <Icon name="arrow" size={16} />
          </button>
        </div>
      </section>
      <section
        id="coordinates-panel"
        role="tabpanel"
        aria-labelledby="coordinates-tab"
        hidden={tab !== 'coordinates'}
      >
        <CoordinatePanel onLocate={onLocate} disabled={disabled} />
      </section>
    </>
  );
}
