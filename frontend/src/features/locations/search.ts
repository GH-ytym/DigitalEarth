import { placeKinds, type PlaceResult } from './types.ts';

export function normalizedQuery(value: string): string {
  return value.normalize('NFKD').replace(/\p{Mn}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, ' ').trim().replace(/\s+/g, ' ');
}

function isPlace(value: unknown): value is PlaceResult {
  if (!value || typeof value !== 'object') return false;
  const place = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(place.geoname_id) && (place.geoname_id as number) > 0 &&
    ['name', 'canonical_name', 'country_code', 'country_name', 'feature_code'].every(
      (key) => typeof place[key] === 'string' && (place[key] as string).length > 0,
    ) &&
    placeKinds.some((kind) => kind === place.kind) &&
    (place.admin1_code === null || typeof place.admin1_code === 'string') &&
    (place.admin1_name === null || typeof place.admin1_name === 'string') &&
    typeof place.longitude === 'number' && Number.isFinite(place.longitude) &&
    place.longitude >= -180 && place.longitude <= 180 &&
    typeof place.latitude === 'number' && Number.isFinite(place.latitude) &&
    place.latitude >= -90 && place.latitude <= 90 &&
    typeof place.approximate_representative_point === 'boolean'
  );
}

export async function searchPlaces(query: string, signal: AbortSignal): Promise<PlaceResult[]> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) controller.abort();
  const timeout = window.setTimeout(() => controller.abort(), 5000);
  try {
    const url = `/api/v1/locations?${new URLSearchParams({ q: query, limit: '6' })}`;
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 400) throw new Error('请输入 2–100 个有效字符。');
      if (response.status === 504) throw new Error('查询超时，请稍后重试。');
      throw new Error('地名查询服务暂不可用，请稍后重试。');
    }
    if (!payload || typeof payload !== 'object' || !('results' in payload) ||
      !Array.isArray(payload.results) || payload.results.length > 10 || !payload.results.every(isPlace)) {
      throw new Error('查询结果格式异常，请稍后重试。');
    }
    return payload.results;
  } catch (error) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (controller.signal.aborted) throw new Error('查询超时，请稍后重试。');
    if (error instanceof TypeError) throw new Error('无法连接地名查询服务，请检查服务后重试。');
    throw error;
  } finally {
    window.clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
  }
}
