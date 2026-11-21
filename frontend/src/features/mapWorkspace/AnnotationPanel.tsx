import { Icon } from '../../components/Icon';
import type { MapWorkspace } from './useMapWorkspace';
import { WorkspaceStatus } from './WorkspaceStatus';

interface Props {
  workspace: MapWorkspace;
  canPick: boolean;
  onMeasure: () => void;
}

export function AnnotationPanel({ workspace, canPick, onMeasure }: Props) {
  const { annotations, annotationDraft: draft, annotationPicking: picking, annotation, status } = workspace;
  const saveBlocked = status.loading || status.busy;

  return (
    <div className="map-workspace-panel">
      {draft ? (
        <form className="map-workspace-form" onSubmit={event => { event.preventDefault(); annotation.save(); }}>
          <h3 className="map-workspace-heading">{draft.id ? '编辑标注' : '新建标注'}</h3>
          <button className="map-workspace-button" type="button" aria-pressed={picking}
            disabled={!canPick || status.busy} onClick={annotation.pick}>
            <Icon name="locate" size={15} />{picking ? '停止地图拾取' : '从地图拾取坐标'}
          </button>
          {picking && <p className="map-workspace-hint" role="status">单击地图放置标注，或直接输入坐标。</p>}
          <label>名称<input value={draft.title} maxLength={120} required disabled={status.busy}
            onChange={event => annotation.change({ title: event.target.value })} /></label>
          <div className="map-workspace-fields">
            <label>经度 °<input inputMode="decimal" value={draft.longitude} required disabled={status.busy}
              onChange={event => annotation.change({ longitude: event.target.value })} /></label>
            <label>纬度 °<input inputMode="decimal" value={draft.latitude} required disabled={status.busy}
              onChange={event => annotation.change({ latitude: event.target.value })} /></label>
          </div>
          <label>备注（选填）<textarea value={draft.note} maxLength={2000} rows={2} disabled={status.busy}
            onChange={event => annotation.change({ note: event.target.value })} /></label>
          <div className="map-workspace-actions">
            <button className="map-workspace-button is-primary" type="submit" disabled={saveBlocked}>
              <Icon name="check" size={15} />保存标注
            </button>
            <button className="map-workspace-button" type="button" onClick={annotation.cancel} disabled={status.busy}>取消</button>
          </div>
        </form>
      ) : (
        <button className="map-workspace-button is-primary" type="button" disabled={status.busy}
          onClick={() => annotation.start()}><Icon name="plus" size={16} />新建标注</button>
      )}
      <WorkspaceStatus status={status} />
      <div className="map-workspace-history">
        <h3 className="map-workspace-heading">已保存标注</h3>
        {!status.loading && !annotations.length && !status.loadError && <p className="map-workspace-hint">暂无标注。</p>}
        <ul className="map-workspace-list">
          {annotations.map(item => (
            <li key={item.id} className={workspace.selection.annotationId === item.id ? 'is-selected' : undefined}>
              <button className="map-workspace-record" type="button" title="定位到标注"
                disabled={!canPick} onClick={() => annotation.focus(item)}>
                <Icon name="pin" size={15} />
                <span><strong>{item.title}</strong><small>{item.longitude.toFixed(4)}°, {item.latitude.toFixed(4)}°</small></span>
              </button>
              <div className="map-workspace-row-actions">
                <button type="button" onClick={() => { if (annotation.measureFrom(item)) onMeasure(); }} disabled={status.busy}>用作测量起点</button>
                <button type="button" onClick={() => annotation.edit(item)} disabled={status.busy}>编辑</button>
                <button type="button" onClick={() => annotation.toggleVisibility(item)} disabled={saveBlocked}>{item.visible ? '隐藏' : '显示'}</button>
                <button type="button" onClick={() => annotation.remove(item)} disabled={saveBlocked}>删除</button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
