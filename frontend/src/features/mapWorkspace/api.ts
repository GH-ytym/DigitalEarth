import type { AnnotationInput, DistanceMeasurement, MapAnnotation, MeasurementInput } from './types.ts';

const workspaceApi = '/api/v1/map-workspace';
const annotationsPath = `${workspaceApi}/annotations`;
const measurementsPath = `${workspaceApi}/measurements`;

async function workspaceRequest<T>(path: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  body?: object, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(8000);
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { Accept: 'application/json', ...(body && { 'Content-Type': 'application/json' }) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (timeout.aborted) throw new Error('成果服务请求超时，请重试。');
    throw new Error('无法连接成果服务，请检查连接后重试。');
  }
  if (response.ok) {
    if (response.status === 204) return undefined as T;
    return response.json().catch(() => { throw new Error('成果服务返回的数据格式异常。'); });
  }
  if ([400, 404, 409, 413, 415, 422].includes(response.status)) {
    const payload = await response.json().catch(() => null);
    if (typeof payload?.error?.message === 'string') throw new Error(payload.error.message);
    throw new Error('请检查成果内容或刷新列表后重试。');
  }
  if (response.status === 504) throw new Error('成果服务请求超时，请重试。');
  throw new Error('成果服务暂不可用，请稍后重试。');
}

async function listWorkspaceRecords<T>(path: string, signal?: AbortSignal): Promise<T[]> {
  const payload = await workspaceRequest<{ items: T[] }>(path, 'GET', undefined, signal);
  if (!Array.isArray(payload?.items)) throw new Error('成果列表格式异常，请刷新后重试。');
  return payload.items;
}

function recordPath(path: string, id: string) {
  return `${path}/${encodeURIComponent(id)}`;
}

export const listAnnotations = (signal?: AbortSignal) => listWorkspaceRecords<MapAnnotation>(annotationsPath, signal);
export const createAnnotation = (input: AnnotationInput) => workspaceRequest<MapAnnotation>(annotationsPath, 'POST', input);
export const updateAnnotation = (id: string, input: Partial<Omit<AnnotationInput, 'id'>>) =>
  workspaceRequest<MapAnnotation>(recordPath(annotationsPath, id), 'PATCH', input);
export const deleteAnnotation = (id: string) => workspaceRequest<void>(recordPath(annotationsPath, id), 'DELETE');

export const listMeasurements = (signal?: AbortSignal) => listWorkspaceRecords<DistanceMeasurement>(measurementsPath, signal);
export const createMeasurement = (input: MeasurementInput) => workspaceRequest<DistanceMeasurement>(measurementsPath, 'POST', input);
export const updateMeasurement = (id: string, input: Partial<Pick<MeasurementInput, 'title' | 'note' | 'visible'>>) =>
  workspaceRequest<DistanceMeasurement>(recordPath(measurementsPath, id), 'PATCH', input);
export const deleteMeasurement = (id: string) => workspaceRequest<void>(recordPath(measurementsPath, id), 'DELETE');
