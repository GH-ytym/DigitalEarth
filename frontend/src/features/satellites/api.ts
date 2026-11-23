import { decodeOrbit } from './orbitCodec';
import type { SavedTrack, SatelliteCatalog, SatelliteJob, SatelliteManifest, SatelliteModelResolution, SatelliteSamples } from './types';

export const satelliteApi = '/api/v1/satellites';
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}
const validDate = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const validUUID = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const positiveNumber = (value: unknown, maximum: number): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= maximum;
function sourceURL(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (!value) return true;
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
}

export function isModelResolution(value: unknown, noradIds: readonly number[]): value is SatelliteModelResolution {
  const required = new Set(noradIds);
  if (!noradIds.length || noradIds.length > 3 || required.size !== noradIds.length ||
      !noradIds.every(id => Number.isSafeInteger(id) && id > 0) || !object(value) ||
      !Array.isArray(value.models) || value.models.length !== required.size) return false;
  const seen = new Set<number>();
  return value.models.every(model => {
    if (!object(model) || !Number.isSafeInteger(model.norad_id) || !required.has(model.norad_id as number) ||
        seen.has(model.norad_id as number) || !validUUID(model.asset_id) || !validUUID(model.version_id) ||
        typeof model.asset_name !== 'string' || !model.asset_name.trim() || !Number.isSafeInteger(model.version) || (model.version as number) < 1 ||
        model.model_url !== `${satelliteApi}/models/versions/${model.version_id}/model.glb` ||
        !object(model.render_options) || !object(model.source_info)) return false;
    const options = model.render_options;
    const source = model.source_info;
    if (!positiveNumber(options.scale, 1e6) || !positiveNumber(options.minimum_pixel_size, 4096) ||
        !positiveNumber(options.maximum_scale, 1e9) || options.maximum_scale < options.scale ||
        typeof source.author !== 'string' || typeof source.title !== 'string' || typeof source.license !== 'string' ||
        !sourceURL(source.source_url) || !sourceURL(source.license_url) ||
        (source.license_text !== undefined && typeof source.license_text !== 'string')) return false;
    seen.add(model.norad_id as number);
    return true;
  });
}

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
  const models = (async () => {
    let response: unknown;
    try {
      response = await satelliteJSON<unknown>(`${satelliteApi}/models/resolve`, signal,
        { norad_ids: manifest.satellites.map(sat => sat.norad_id) });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Error(`卫星模型解析失败：${error instanceof Error ? error.message : '请检查模型服务。'}`);
    }
    if (!isModelResolution(response, manifest.satellites.map(sat => sat.norad_id))) {
      throw new Error('卫星模型配置格式异常，当前场景已保留。');
    }
    return response.models;
  })();
  const [samples, resolvedModels] = await Promise.all([loadBinarySamples(manifest, signal), models]);
  if (!isSamples(samples, manifest)) throw new Error('卫星轨迹采样格式异常。');
  return { manifest, samples, models: resolvedModels };
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

async function loadBinarySamples(manifest: SatelliteManifest, signal: AbortSignal): Promise<SatelliteSamples> {
  const satellites = await Promise.all(manifest.satellites.map(async sat => {
    if ('blocks' in sat && Array.isArray(sat.blocks)) {
      const samples: number[][] = [];
      for (const block of sat.blocks) {
        const match = /^orbit-blocks\/(\d+)\/([0-9a-f]{64})\.orb$/.exec(block.key);
        if (!match || Number(match[1]) !== sat.norad_id || block.start !== samples.length * manifest.output_step_s)
          throw new Error('轨迹分块索引无效');
        const response = await fetch(`${satelliteApi}/blocks/${match[1]}/${match[2]}`, { signal });
        if (!response.ok) throw new Error('轨迹分块加载失败');
        const rows = decodeOrbit(await response.arrayBuffer());
        if (rows.length !== block.count) throw new Error('轨迹分块长度错误');
        for (const row of rows) { row[0] += block.start; samples.push(row); }
      }
      return { satellite_id: sat.satellite_id, samples };
    }
    const response = await fetch(`${satelliteApi}/tracks/${manifest.result_id}/binary/${sat.norad_id}`, { signal });
    if (!response.ok) throw new Error('轨迹包加载失败');
    return { satellite_id: sat.satellite_id, samples: decodeOrbit(await response.arrayBuffer()) };
  }));
  return { schema_version: 'satellite-samples-1', result_id: manifest.result_id, satellites };
}
