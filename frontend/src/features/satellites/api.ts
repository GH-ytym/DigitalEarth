import type { SavedTrack, SatelliteCatalog, SatelliteJob, SatelliteManifest, SatelliteSamples } from './types';

export const satelliteApi = '/api/v1/satellites';
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}
const validDate = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

export function isManifest(value: unknown): value is SatelliteManifest {
  if (!object(value) || value.schema_version !== 'satellites-1' || value.position_frame !== 'ECEF_APPROX' || value.position_unit !== 'm') return false;
  if (typeof value.result_id !== 'string' || !/^[0-9a-f-]{36}$/.test(value.result_id) ||
      !validDate(value.epoch_utc) || !validDate(value.stop_utc) ||
      typeof value.duration_s !== 'number' || !Number.isFinite(value.duration_s) || value.duration_s <= 0 || value.duration_s > 86400 ||
      typeof value.output_step_s !== 'number' || !Number.isFinite(value.output_step_s) || value.output_step_s < 1 ||
      !['current-window', 'historical'].includes(value.window_kind as string) ||
      value.samples_url !== `${satelliteApi}/tracks/${value.result_id}/samples`) return false;
  if (!Array.isArray(value.satellites) || value.satellites.length < 1 || value.satellites.length > 3) return false;
  const satellites = value.satellites;
  return satellites.every(sat => object(sat) && typeof sat.satellite_id === 'string' &&
    /^norad-\d+$/.test(sat.satellite_id) && Number.isSafeInteger(sat.norad_id) &&
    typeof sat.display_name === 'string' && typeof sat.object_name === 'string' &&
    Number.isSafeInteger(sat.sample_count) && (sat.sample_count as number) >= 2 && (sat.sample_count as number) <= 20000 &&
    typeof sat.period_s === 'number' && Number.isFinite(sat.period_s) && sat.period_s > 0 &&
    validDate(sat.element_epoch_utc) && validDate(sat.fetched_at) &&
    typeof sat.source_url === 'string' && sat.source_url.startsWith('https://celestrak.org/')) &&
    new Set(satellites.map(sat => sat.satellite_id)).size === satellites.length;
}

export function isSamples(value: unknown, manifest: SatelliteManifest): value is SatelliteSamples {
  if (!object(value) || value.schema_version !== 'satellite-samples-1' || value.result_id !== manifest.result_id ||
      !Array.isArray(value.satellites) || value.satellites.length !== manifest.satellites.length) return false;
  const tracks = value.satellites;
  return manifest.satellites.every(spec => {
    const matches = tracks.filter(track => object(track) && track.satellite_id === spec.satellite_id);
    if (matches.length !== 1 || !Array.isArray(matches[0].samples) || matches[0].samples.length !== spec.sample_count) return false;
    return matches[0].samples.every((row: unknown, i: number) => Array.isArray(row) && row.length === 4 &&
      row.every((n: unknown) => typeof n === 'number' && Number.isFinite(n)) &&
      Math.abs(row[0] - i * manifest.output_step_s) < 1e-7 &&
      (i !== spec.sample_count - 1 || Math.abs(row[0] - manifest.duration_s) < 1e-7));
  });
}

export async function satelliteJSON<T>(path: string, signal: AbortSignal, body?: unknown): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) controller.abort();
  const timeout = window.setTimeout(abort, 60000);
  try {
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST',
      signal: controller.signal, headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      if (object(payload) && typeof payload.detail === 'string') throw new Error(payload.detail);
      throw new Error('卫星轨迹服务暂不可用，请确认服务已启动后重试。');
    }
    if (!payload) throw new Error('卫星服务返回的数据格式异常。');
    return payload as T;
  } catch (error) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (controller.signal.aborted) throw new Error('卫星服务请求超时，请稍后重试。');
    if (error instanceof TypeError) throw new Error('无法连接卫星服务，请启动服务后重试。');
    throw error;
  } finally {
    window.clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
  }
}

export async function loadSavedTrack(id: string, signal: AbortSignal) {
  const manifest = await satelliteJSON<unknown>(`${satelliteApi}/tracks/${id}`, signal);
  if (!isManifest(manifest)) throw new Error('卫星成果说明格式异常。');
  const samples = await satelliteJSON<unknown>(manifest.samples_url, signal);
  if (!isSamples(samples, manifest)) throw new Error('卫星轨迹采样格式异常。');
  return { manifest, samples };
}
export async function loadSelectedTrack(ids: number[], signal: AbortSignal) {
  const submitted = await satelliteJSON<SatelliteJob>(`${satelliteApi}/tracks`, signal, { norad_ids: ids });
  let job = submitted;
  const deadline = performance.now() + 120000;
  while (job.status === 'queued' || job.status === 'running') {
    if (performance.now() > deadline) throw new Error('轨迹尚未完成，可稍后从已保存结果重新加载。');
    await new Promise<void>((resolve, reject) => {
      const abort = () => { window.clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
      const timer = window.setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 350);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    job = await satelliteJSON<SatelliteJob>(`${satelliteApi}/jobs/${job.job_id}`, signal);
  }
  if (job.status !== 'succeeded') throw new Error(job.error || '卫星轨迹生成失败。');
  return { ...await loadSavedTrack(job.result_id, signal), reused: !!submitted.cache_hit };
}
export async function readCatalog(signal: AbortSignal, refresh = false): Promise<SatelliteCatalog> {
  const catalog = await satelliteJSON<SatelliteCatalog>(`${satelliteApi}/${refresh ? 'refresh' : 'catalog'}`, signal, refresh ? {} : undefined);
  if (!Number.isSafeInteger(catalog.max_selected) || catalog.max_selected < 1 || catalog.max_selected > 3 ||
    !Array.isArray(catalog.satellites) || !catalog.satellites.length || !catalog.satellites.every(sat =>
    Number.isSafeInteger(sat.norad_id) && typeof sat.display_name === 'string' && validDate(sat.epoch_utc) &&
    typeof sat.category === 'string' && typeof sat.category_name === 'string' && ['LEO', 'MEO', 'GEO'].includes(sat.orbit_type))) {
    throw new Error('公开卫星目录格式异常。');
  }
  return catalog;
}
export async function readHistory(signal: AbortSignal): Promise<SavedTrack[]> {
  const data = await satelliteJSON<{ results: SavedTrack[] }>(`${satelliteApi}/tracks`, signal);
  if (!Array.isArray(data.results)) throw new Error('轨迹列表格式异常。');
  return data.results.filter(row => row.status === 'succeeded' && isManifest(row.manifest));
}
