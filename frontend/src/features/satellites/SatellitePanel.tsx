import { useEffect, useRef, useState } from 'react';
import { loadSavedTrack, loadSelectedTrack, readCatalog, readHistory } from './api';
import type { SavedTrack, SatelliteCatalog, SatelliteManifest, SatellitePlaybackState, SatelliteSamples } from './types';

export function satelliteTime(value: string) {
  return `${value.replace('T', ' ').slice(0, 19)} UTC`;
}
interface Props {
  active: boolean;
  playback: SatellitePlaybackState | null;
  ready: boolean;
  onLoad: (manifest: SatelliteManifest, samples: SatelliteSamples) => void;
  onFocus: () => void;
  onClear: () => void;
}

export function SatellitePanel({ active, playback, ready, onLoad, onFocus, onClear }: Props) {
  const [catalog, setCatalog] = useState<SatelliteCatalog | null>(null);
  const [selected, setSelected] = useState<number[]>([25544, 20580, 43013]);
  const [history, setHistory] = useState<SavedTrack[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('选择公开卫星，加载后在同一地球场景中回放。');
  const [error, setError] = useState<string | null>(null);
  const operation = useRef<AbortController | null>(null);
  const catalogLoaded = useRef(false);

  useEffect(() => () => operation.current?.abort(), []);
  useEffect(() => {
    if (!active || catalogLoaded.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    Promise.all([readCatalog(controller.signal), readHistory(controller.signal)])
      .then(([value, rows]) => { if (!controller.signal.aborted) { catalogLoaded.current = true; setCatalog(value); setHistory(rows); setError(value.update_error); } })
      .catch(err => { if (!controller.signal.aborted) setError(err.message); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [active]);

  async function act(action: 'load' | 'refresh' | string) {
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError(null);
    try {
      if (action === 'refresh') {
        const value = await readCatalog(controller.signal, true);
        catalogLoaded.current = true;
        setCatalog(value);
        setError(value.update_error);
        setMessage('已读取公开要素快照；数据源更新间隔至少为两小时。');
      } else {
        setMessage(action === 'load' ? '正在获取公开要素对应的轨迹…' : '正在读取已保存轨迹…');
        const data = action === 'load'
          ? await loadSelectedTrack(selected, controller.signal)
          : await loadSavedTrack(action, controller.signal);
        if (controller.signal.aborted) return;
        onLoad(data.manifest, data.samples);
        setSelected(data.manifest.satellites.map(sat => sat.norad_id));
        setMessage(action !== 'load' ? '已加载历史成果，无需重新传播轨道。'
          : 'reused' in data && data.reused ? '已复用保存的轨迹成果。' : '轨迹已生成并保存。');
        setHistory(await readHistory(controller.signal));
      }
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : '卫星数据加载失败。');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return <div className="satellite-panel-content">
    <p className="panel-description">使用 CelesTrak 公开 GP 要素，由后端 SGP4 生成轨迹。页面位置为轨道推算，不是实时遥测。</p>
    <div className="satellite-source-heading"><strong>公开卫星</strong><button className="text-button" disabled={busy} onClick={() => void act('refresh')}>更新数据</button></div>
    {catalog?.satellites.map(sat => {
      const position = playback?.positions.find(p => p.satellite_id === `norad-${sat.norad_id}`);
      return <label className="satellite-choice" key={sat.norad_id}>
        <input type="checkbox" checked={selected.includes(sat.norad_id)} disabled={busy}
          onChange={event => setSelected(previous => event.target.checked ? [...previous, sat.norad_id] : previous.filter(id => id !== sat.norad_id))} />
        <span><strong>{sat.display_name}</strong><small>{sat.object_name} · NORAD {sat.norad_id}</small>
          <small>要素 {satelliteTime(sat.epoch_utc)}</small>
          {sat.age_hours > 24 && <small>要素已超过 24 小时，请留意有效期。</small>}
          {position && <small className="satellite-position">{position.longitude.toFixed(2)}°，{position.latitude.toFixed(2)}° · {(position.height / 1000).toFixed(1)} km</small>}
        </span>
      </label>;
    })}
    {!catalog && !busy && <button className="text-button" onClick={() => void act('refresh')}>重新获取卫星目录</button>}
    <button className="primary-button satellite-load" disabled={busy || !ready || !catalog || !selected.length}
      onClick={() => void act('load')}>{busy ? '正在加载…' : '加载所选卫星轨迹'}</button>
    <p className="satellite-message" role="status">{message}</p>
    {error && <p className="satellite-error" role="alert">{error}</p>}
    {playback && <>
      <div className="satellite-result-info">
        <p>回放起点：{satelliteTime(playback.manifest.epoch_utc)}</p>
        <p>来源：CelesTrak · C++ SGP4</p>
        <p>成果：{playback.manifest.result_id.slice(0, 8)} · 2 小时时段</p>
        {playback.manifest.window_kind === 'historical' && <p>当前使用较旧要素对应的历史时段。</p>}
      </div>
      <div className="satellite-actions"><button className="text-button" onClick={onFocus}>查看全部轨迹</button><button className="text-button" onClick={onClear}>卸载轨迹</button></div>
      <details className="satellite-provenance"><summary>数据获取时间与来源</summary>
        {playback.manifest.satellites.map(sat => <p key={sat.satellite_id}><a href={sat.source_url} target="_blank" rel="noreferrer">{sat.object_name}</a><br />获取：{satelliteTime(sat.fetched_at)}</p>)}
        <p>SGP4 输出 TEME，后端按 GMST 转为近似地固坐标，UT1 取 UTC、极移取零。</p>
      </details>
    </>}
    <div className="panel-divider" />
    <h3 className="section-title">已保存轨迹</h3>
    {!history.length && <p className="satellite-message">加载成功后自动保存，刷新页面仍可读取。</p>}
    <div className="satellite-history">{history.slice(0, 6).map(row => <button key={row.result_id} type="button" disabled={busy || !ready}
      onClick={() => void act(row.result_id)}><strong>{row.manifest!.satellites.map(sat => sat.object_name).join(' / ')}</strong>
      <small>{satelliteTime(row.manifest!.epoch_utc)} · {row.result_id.slice(0, 8)}</small></button>)}</div>
  </div>;
}
