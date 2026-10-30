import { useState } from 'react';
import type { FormEvent } from 'react';
import { Icon } from '../../components/Icon';

interface Props {
  onLocate: (longitude: number, latitude: number, altitude: number) => void;
  disabled: boolean;
}

/** Coordinate navigation is available now; real place search will use the future Go API. */
export function CoordinatePanel({ onLocate, disabled }: Props) {
  const [longitude, setLongitude] = useState('116.4074');
  const [latitude, setLatitude] = useState('39.9042');
  const [altitude, setAltitude] = useState('800000');
  const [error, setError] = useState('');

  function submit(event: FormEvent) {
    event.preventDefault();
    const values = [longitude, latitude, altitude];
    const [lon, lat, height] = values.map(Number);
    if (
      values.some((value) => !value.trim()) ||
      !values.every((value) => Number.isFinite(Number(value)))
    ) {
      setError('请填写有效的经度、纬度和视角高度。');
      return;
    }
    if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
      setError('经度应在 −180° 至 180°，纬度应在 −90° 至 90°。');
      return;
    }
    if (height < 100 || height > 100_000_000) {
      setError('视角高度应在 100 至 100,000,000 米之间。');
      return;
    }
    setError('');
    onLocate(lon, lat, height);
  }

  return (
    <>
      <p className="panel-description">输入地理坐标，飞行至目标位置。</p>
      <div className="reference-note">
        <Icon name="info" size={16} />
        <span>WGS84 · 十进制度 · 经度在前</span>
      </div>
      <form onSubmit={submit} className="coordinate-form" noValidate>
        <label>
          经度 <span>°</span>
          <input
            inputMode="decimal"
            value={longitude}
            onChange={(e) => setLongitude(e.target.value)}
            aria-label="经度"
          />
        </label>
        <label>
          纬度 <span>°</span>
          <input
            inputMode="decimal"
            value={latitude}
            onChange={(e) => setLatitude(e.target.value)}
            aria-label="纬度"
          />
        </label>
        <label>
          视角高度 <span>m</span>
          <input
            inputMode="decimal"
            value={altitude}
            onChange={(e) => setAltitude(e.target.value)}
            aria-label="视角高度"
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button className="primary-button" type="submit" disabled={disabled}>
          <Icon name="locate" size={17} />
          定位到坐标
          <Icon name="arrow" size={16} />
        </button>
      </form>
    </>
  );
}
