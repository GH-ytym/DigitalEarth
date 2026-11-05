import { useState } from 'react';
import { CoordinatePanel } from './CoordinatePanel';
import { PlaceSearchPanel } from './PlaceSearchPanel';
import type { PlaceResult } from './types';

interface Props {
  onLocate: (longitude: number, latitude: number, altitude: number) => void;
  disabled: boolean;
  active: boolean;
  selectedPlaceId?: number;
  onSelectPlace: (place: PlaceResult) => void;
}

export function QueryPanel({ onLocate, disabled, active, selectedPlaceId, onSelectPlace }: Props) {
  const [tab, setTab] = useState<'places' | 'coordinates'>('places');

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
        <PlaceSearchPanel active={active && tab === 'places'} disabled={disabled} selectedPlaceId={selectedPlaceId} onSelect={onSelectPlace} />
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
