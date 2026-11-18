import type { SatellitePlaybackState } from './types';
import { satelliteTime } from './SatellitePanel';

interface Props {
  state: SatellitePlaybackState;
  onPlay: (enabled: boolean) => void;
  onSeek: (elapsed: number) => void;
  onSpeed: (speed: number) => void;
  onFollow: (id: string | null) => void;
  onClose: () => void;
}
export function SatelliteControls({ state, onPlay, onSeek, onSpeed, onFollow, onClose }: Props) {
  return <section className="floating-panel satellite-controls" aria-label="卫星轨迹回放">
    <div className="satellite-control-top">
      <div className="satellite-control-buttons">
        <button onClick={() => onPlay(!state.playing)}>{state.playing ? '暂停' : '播放'}</button>
        <button onClick={() => onSeek(0)}>回到起点</button>
        <label>倍速<select aria-label="卫星回放倍速" value={state.speed} onChange={event => onSpeed(Number(event.target.value))}>
          {[1, 30, 60, 120, 300].map(value => <option value={value} key={value}>{value}×</option>)}
        </select></label>
        <label>跟随<select aria-label="跟随卫星" value={state.following ?? ''} onChange={event => onFollow(event.target.value || null)}>
          <option value="">自由视角</option>{state.manifest.satellites.map(sat => <option value={sat.satellite_id} key={sat.satellite_id}>{sat.object_name}</option>)}
        </select></label>
      </div>
      <time>{satelliteTime(state.currentUtc)}</time>
      <button className="text-button" aria-label="关闭卫星轨迹" onClick={onClose}>关闭</button>
    </div>
    <div className="satellite-time-label"><span>公开要素推算轨迹</span><span>{Math.floor(state.elapsed)} / {state.manifest.duration_s} s</span></div>
    <input type="range" aria-label="卫星回放时间" min="0" max={state.manifest.duration_s} step="1"
      value={Math.floor(state.elapsed)} onChange={event => onSeek(Number(event.target.value))} />
  </section>;
}
