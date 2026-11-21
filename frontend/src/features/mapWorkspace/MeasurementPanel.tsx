import { Icon } from '../../components/Icon';
import { formatDistance } from './distance';
import type { MeasurementMode, WorkspaceVertex } from './types';
import { maximumMeasurementVertices } from './useMapWorkspace';
import type { MapWorkspace } from './useMapWorkspace';
import { WorkspaceStatus } from './WorkspaceStatus';

const modeChoices = [
  { id: 'polyline', title: '折线测量', icon: 'polyline' },
  { id: 'straight', title: '直线测量', icon: 'straightLine' },
] as const satisfies readonly { id: MeasurementMode; title: string; icon: 'polyline' | 'straightLine' }[];

function vertexName(vertex: WorkspaceVertex, index: number) {
  return vertex.name ?? `点 ${index + 1}`;
}

interface Props {
  workspace: MapWorkspace;
  canPick: boolean;
}

export function MeasurementPanel({ workspace, canPick }: Props) {
  const { measurementDraft: draft, measurementSeed: seed, measurement, measurements, selection,
    status, currentDistance, hoveredVertex } = workspace;
  const saved = selection.measurement;
  const displayed = saved ?? currentDistance;
  const mode = saved?.mode ?? draft?.mode;
  const blocked = status.loading || status.busy;
  const hoverName = hoveredVertex?.name;
  const atVertexLimit = draft?.vertices.length === maximumMeasurementVertices;

  return (
    <div className="map-workspace-panel">
      <h3 className="map-workspace-heading">测量方式</h3>
      <div className="map-measure-modes" role="group" aria-label="测量方式">
        {modeChoices.map(choice => (
          <button className="map-workspace-button" type="button" key={choice.id}
            disabled={!canPick || status.busy}
            aria-pressed={mode === choice.id}
            onClick={() => {
              if (!saved && draft?.mode === choice.id) return;
              measurement.begin(choice.id);
            }}>
            <Icon name={choice.icon} size={24} />{choice.title}
          </button>
        ))}
      </div>
      {!draft && !saved && <p className="map-workspace-hint" role="status">
        {seed ? `起点：${seed.name ?? '选中标注'}。请选择测量方式。` : '选择测量方式后，在地图上点选。'}
      </p>}
      {draft && !saved && !draft.finished && <p className="map-workspace-hint" role="status">
        <span>{atVertexLimit ? `已达到 ${maximumMeasurementVertices} 个点。请完成测量。` :
          draft.vertices.length === 0 ? '在地图上选择起点。' : draft.mode === 'straight' ? '选择终点，测量自动完成。' :
          '依次选点，点击完成测量或按 Enter。'}</span>
        {hoverName && <span className="map-measure-snap">吸附到 {hoverName}</span>}
      </p>}
      {saved && <p className="map-measure-selected"><strong>{saved.title}</strong>
        {saved.note && <small>{saved.note}</small>}{!saved.visible && <small>测量线已隐藏。</small>}
      </p>}
      {displayed && displayed.vertices.length > 0 && (
        <div className="map-measure-result">
          <div className="map-measure-total"><span>总距离</span><strong>{formatDistance(displayed.total_meters)}</strong></div>
          {displayed.segment_meters.length > 0 && <ol className="map-measure-segments" aria-label="分段距离">
            {displayed.segment_meters.map((distance, index) => {
              const name = `${vertexName(displayed.vertices[index], index)} → ${vertexName(displayed.vertices[index + 1], index + 1)}`;
              return <li key={index}>
                <button type="button" aria-pressed={selection.segment === index} title={name}
                  onClick={() => measurement.selectSegment(index)}>
                  <span className="map-measure-index">{index + 1}</span><span className="map-measure-segment-name">{name}</span>
                  <strong>{formatDistance(distance)}</strong>
                </button>
              </li>;
            })}
          </ol>}
        </div>
      )}
      {draft && !saved && !draft.finished && <div className="map-workspace-actions">
        {draft.mode === 'polyline' && <button className="map-workspace-button is-primary" type="button"
          onClick={measurement.finish} disabled={draft.vertices.length < 2 || status.busy}>完成测量</button>}
        {draft.vertices.length > 0 && <button className="map-workspace-button" type="button"
          onClick={measurement.undo} disabled={status.busy}>撤销上一点</button>}
        <button className="map-workspace-button" type="button" onClick={measurement.cancel} disabled={status.busy}>清除本次</button>
      </div>}
      {draft && !saved && draft.finished && <form className="map-workspace-form"
        onSubmit={event => { event.preventDefault(); measurement.save(); }}>
        <label>测量名称<input value={draft.title} maxLength={120} required disabled={status.busy}
          onChange={event => measurement.change({ title: event.target.value })} /></label>
        <label>备注（选填）<textarea value={draft.note} maxLength={2000} rows={2} disabled={status.busy}
          onChange={event => measurement.change({ note: event.target.value })} /></label>
        <div className="map-workspace-actions">
          <button className="map-workspace-button is-primary" type="submit" disabled={blocked}>
            <Icon name="check" size={15} />保存测量
          </button>
          <button className="map-workspace-button" type="button" onClick={measurement.undo} disabled={status.busy}>撤销上一点</button>
          <button className="map-workspace-button" type="button" onClick={measurement.cancel} disabled={status.busy}>清除本次</button>
        </div>
      </form>}
      {saved && draft && <button className="map-workspace-button" type="button" onClick={measurement.resume}>返回本次测量</button>}
      <p className="map-measure-reference">测量口径 · WGS84 椭球面距离</p>
      <WorkspaceStatus status={status} />
      <div className="map-workspace-history">
        <h3 className="map-workspace-heading">已保存测量</h3>
        {!status.loading && !measurements.length && !status.loadError && <p className="map-workspace-hint">暂无测量记录。</p>}
        <ul className="map-workspace-list">
          {measurements.map(item => <li key={item.id} className={saved?.id === item.id ? 'is-selected' : undefined}>
            <button className="map-workspace-record" type="button" title="定位到测量" disabled={!canPick}
              onClick={() => measurement.select(item)}>
              <Icon name={item.mode === 'polyline' ? 'polyline' : 'straightLine'} size={15} />
              <span><strong>{item.title}</strong><small>{item.mode === 'polyline' ? '折线' : '直线'} · {formatDistance(item.total_meters)}</small></span>
            </button>
            <div className="map-workspace-row-actions">
              <button type="button" onClick={() => measurement.toggleVisibility(item)} disabled={blocked}>{item.visible ? '隐藏' : '显示'}</button>
              <button type="button" onClick={() => measurement.remove(item)} disabled={blocked}>删除</button>
            </div>
          </li>)}
        </ul>
      </div>
    </div>
  );
}
