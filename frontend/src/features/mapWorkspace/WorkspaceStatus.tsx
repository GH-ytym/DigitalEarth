import type { MapWorkspace } from './useMapWorkspace';

export function WorkspaceStatus({ status }: { status: MapWorkspace['status'] }) {
  return (
    <>
      {status.loading && <p className="map-workspace-hint" role="status">正在读取已保存成果…</p>}
      {status.busy && <p className="map-workspace-hint" role="status">正在提交更改…</p>}
      {status.loadError && <div className="map-workspace-feedback" role="alert">
        <p>{status.loadError}</p>
        <button className="map-workspace-button" type="button" disabled={status.busy} onClick={status.reload}>重新加载</button>
      </div>}
      {status.actionError && <div className="map-workspace-feedback" role="alert"><p>{status.actionError}</p></div>}
      {status.notice && <p className="map-workspace-hint" role="status">{status.notice}</p>}
    </>
  );
}
