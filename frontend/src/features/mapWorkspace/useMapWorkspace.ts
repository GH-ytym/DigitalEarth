import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SceneController } from '../globe/SceneController';
import {
  createAnnotation, createMeasurement, deleteAnnotation, deleteMeasurement,
  listAnnotations, listMeasurements, updateAnnotation, updateMeasurement,
} from './api';
import { measureDistance } from './distance';
import type { DistanceMeasurement, MapAnnotation, MeasurementMode, WorkspaceVertex } from './types';

export interface AnnotationDraft {
  id?: string;
  title: string;
  note: string;
  longitude: string;
  latitude: string;
  source_geoname_id?: string;
  visible: boolean;
}

interface MeasurementDraft {
  mode: MeasurementMode;
  vertices: WorkspaceVertex[];
  finished: boolean;
  title: string;
  note: string;
}

export const maximumMeasurementVertices = 256;

function draftFromVertex(vertex?: WorkspaceVertex): AnnotationDraft {
  return {
    title: vertex?.name ?? '',
    note: '',
    longitude: vertex ? String(vertex.longitude) : '',
    latitude: vertex ? String(vertex.latitude) : '',
    source_geoname_id: vertex?.source_geoname_id,
    visible: true,
  };
}

function annotationVertex(draft: AnnotationDraft | null): WorkspaceVertex | null {
  if (!draft?.longitude.trim() || !draft.latitude.trim()) return null;
  const longitude = Number(draft.longitude);
  const latitude = Number(draft.latitude);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude) ||
    Math.abs(longitude) > 180 || Math.abs(latitude) > 90) return null;
  return { longitude, latitude, name: draft.title.trim() || undefined };
}

function vertexFromAnnotation(annotation: MapAnnotation): WorkspaceVertex {
  return {
    longitude: annotation.longitude,
    latitude: annotation.latitude,
    name: annotation.title,
    annotation_id: annotation.id,
    source_geoname_id: annotation.source_geoname_id,
  };
}

function samePoint(first: WorkspaceVertex | undefined, second: WorkspaceVertex | null) {
  if (!first || !second || Math.abs(first.latitude - second.latitude) > 1e-8) return false;
  const delta = Math.abs(first.longitude - second.longitude);
  return delta < 1e-8 || Math.abs(delta - 360) < 1e-8 || Math.abs(first.latitude) === 90;
}

function defaultMeasurementTitle(vertices: WorkspaceVertex[], mode: MeasurementMode) {
  const start = vertices[0]?.name;
  const end = vertices.at(-1)?.name;
  return start && end ? Array.from(`${start} → ${end}`).slice(0, 120).join('') :
    mode === 'straight' ? '直线测量' : '折线测量';
}

function upsert<T extends { id: string }>(items: T[], item: T) {
  return items.some(row => row.id === item.id)
    ? items.map(row => row.id === item.id ? item : row)
    : [item, ...items];
}

export function useMapWorkspace(
  controller: SceneController | null,
  tool: 'annotations' | 'measurements' | null,
  canPick: boolean,
) {
  const [annotations, setAnnotations] = useState<MapAnnotation[]>([]);
  const [measurements, setMeasurements] = useState<DistanceMeasurement[]>([]);
  const [annotationDraft, setAnnotationDraft] = useState<AnnotationDraft | null>(null);
  const [annotationPicking, setAnnotationPicking] = useState(false);
  const [measurementDraft, setMeasurementDraft] = useState<MeasurementDraft | null>(null);
  const [measurementSeed, setMeasurementSeed] = useState<WorkspaceVertex | null>(null);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [selectedMeasurementId, setSelectedMeasurementId] = useState<string | null>(null);
  const [highlightedSegment, setHighlightedSegment] = useState<number | null>(null);
  const [hoveredVertex, setHoveredVertex] = useState<WorkspaceVertex | null>(null);
  const [labelsVisible, setLabelsVisible] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  const busyRef = useRef(false);
  const annotationSave = useRef<{ input: string; id: string } | null>(null);
  const measurementSave = useRef<{ input: string; id: string } | null>(null);
  const annotationActive = tool === 'annotations' && annotationPicking && canPick && !busy;
  const measuring = tool === 'measurements' && !!measurementDraft &&
    !selectedMeasurementId && !measurementDraft.finished && canPick && !busy;
  const measurementActive = measuring && measurementDraft.vertices.length < maximumMeasurementVertices;
  const selectedMeasurement = measurements.find(item => item.id === selectedMeasurementId);

  useEffect(() => {
    const request = new AbortController();
    setLoading(true);
    setLoadError('');
    void Promise.all([listAnnotations(request.signal), listMeasurements(request.signal)]).then(([points, lines]) => {
      if (request.signal.aborted) return;
      setAnnotations(points);
      setMeasurements(lines);
    }).catch((error: unknown) => {
      if (request.signal.aborted) return;
      setLoadError(error instanceof Error ? error.message : '无法读取已保存成果。');
    }).finally(() => { if (!request.signal.aborted) setLoading(false); });
    return () => request.abort();
  }, [refresh]);

  useEffect(() => {
    controller?.setMapLabelsVisible(labelsVisible);
  }, [controller, labelsVisible]);

  useEffect(() => {
    if (!controller || (!annotationActive && !measurementActive)) {
      controller?.setWorkspaceInput(null);
      setHoveredVertex(null);
      return;
    }
    controller.setWorkspaceInput({
      onPick(vertex) {
        if (annotationActive) {
          setAnnotationDraft(draft => draft && {
            ...draft,
            longitude: String(vertex.longitude), latitude: String(vertex.latitude),
            title: draft.title || vertex.name || '',
            source_geoname_id: draft.id ? draft.source_geoname_id : vertex.source_geoname_id,
          });
          setAnnotationPicking(false);
          return;
        }
        setHighlightedSegment(null);
        setMeasurementDraft(draft => {
          if (!draft || draft.finished || draft.vertices.length >= maximumMeasurementVertices ||
            samePoint(draft.vertices.at(-1), vertex)) return draft;
          const vertices = [...draft.vertices, vertex];
          const finished = draft.mode === 'straight' && vertices.length === 2;
          const title = finished && !draft.title ? defaultMeasurementTitle(vertices, draft.mode) : draft.title;
          return { ...draft, vertices, finished, title };
        });
      },
      onHover: measurementActive ? setHoveredVertex : () => {},
    });
    return () => controller.setWorkspaceInput(null);
  }, [controller, annotationActive, measurementActive]);

  const draftVertices = measurementDraft?.vertices;
  const activeMeasurement = useMemo(() => !selectedMeasurementId && draftVertices?.length
    ? { vertices: draftVertices, ...measureDistance(draftVertices) } : undefined,
  [selectedMeasurementId, draftVertices]);
  const preview = measurementActive && !samePoint(draftVertices?.at(-1), hoveredVertex) ? hoveredVertex : null;

  useEffect(() => {
    controller?.setWorkspaceOverlay({
      annotations,
      measurements,
      activeMeasurement,
      preview,
      highlightedSegment: tool === 'measurements' ? highlightedSegment : null,
      selectedAnnotationId,
      draftAnnotation: tool === 'annotations' ? annotationVertex(annotationDraft) : null,
      selectedMeasurementId,
    });
  }, [controller, annotations, measurements, activeMeasurement, preview, highlightedSegment,
    selectedAnnotationId, annotationDraft, selectedMeasurementId, tool]);

  const finishMeasurement = useCallback(() => {
    setMeasurementDraft(draft => draft && !draft.finished && draft.vertices.length >= 2 ? {
      ...draft, finished: true, title: draft.title || defaultMeasurementTitle(draft.vertices, draft.mode),
    } : draft);
  }, []);

  const clearMeasurement = useCallback(() => {
    measurementSave.current = null;
    setMeasurementDraft(null);
    setMeasurementSeed(null);
    setHighlightedSegment(null);
    setSelectedMeasurementId(null);
    setActionError('');
  }, []);

  function closeAnnotationDraft() {
    setAnnotationDraft(null);
    setAnnotationPicking(false);
    annotationSave.current = null;
    setActionError('');
  }

  useEffect(() => {
    if (!tool || busy) return;
    function shortcut(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.repeat ||
        (event.target instanceof HTMLElement &&
          event.target.closest('input, textarea, select, [contenteditable="true"]'))) return;
      if (event.key === 'Enter' && event.target instanceof HTMLElement && event.target.closest('button, a')) return;
      if (event.key === 'Enter' && measuring && measurementDraft.mode === 'polyline' &&
        measurementDraft.vertices.length >= 2) {
        event.preventDefault();
        finishMeasurement();
      } else if (event.key === 'Escape' && measuring) {
        event.preventDefault();
        clearMeasurement();
      } else if (event.key === 'Escape' && annotationActive) {
        event.preventDefault();
        setAnnotationPicking(false);
      }
    }
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [tool, busy, annotationActive, measuring, measurementDraft, finishMeasurement, clearMeasurement]);

  async function commit(operation: () => Promise<void>, success: string) {
    if (busyRef.current || loading) return;
    busyRef.current = true;
    setBusy(true);
    setActionError('');
    setNotice('');
    try {
      await operation();
      setNotice(success);
    } catch (error: unknown) {
      setActionError(error instanceof Error ? error.message : '操作失败，请重试。');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function startAnnotation(vertex?: WorkspaceVertex) {
    if (annotationDraft && !window.confirm('替换当前未保存的标注？')) return false;
    annotationSave.current = null;
    setAnnotationDraft(draftFromVertex(vertex));
    setAnnotationPicking(!vertex);
    setSelectedAnnotationId(null);
    setActionError('');
    setNotice('');
    return true;
  }

  function editAnnotation(annotation: MapAnnotation) {
    if (annotationDraft && annotationDraft.id !== annotation.id && !window.confirm('放弃当前未保存的标注？')) return;
    setSelectedAnnotationId(annotation.id);
    setAnnotationDraft({
      ...annotation,
      longitude: String(annotation.longitude),
      latitude: String(annotation.latitude),
    });
    setAnnotationPicking(false);
    setActionError('');
    setNotice('');
  }

  function changeAnnotation(fields: Partial<AnnotationDraft>) {
    setAnnotationDraft(draft => draft && { ...draft, ...fields });
  }

  function saveAnnotationDraft() {
    const vertex = annotationVertex(annotationDraft);
    if (!annotationDraft || !vertex || !vertex.name) {
      setActionError('请填写名称及 WGS84 经纬度。经度范围为 −180° 至 180°，纬度范围为 −90° 至 90°。');
      return;
    }
    const input = {
      title: vertex.name,
      note: annotationDraft.note.trim(),
      longitude: vertex.longitude,
      latitude: vertex.latitude,
      source_geoname_id: annotationDraft.source_geoname_id,
      visible: annotationDraft.visible,
    };
    void commit(async () => {
      let saved: MapAnnotation;
      if (annotationDraft.id) saved = await updateAnnotation(annotationDraft.id, input);
      else {
        const key = JSON.stringify(input);
        if (annotationSave.current?.input !== key) annotationSave.current = { input: key, id: crypto.randomUUID() };
        saved = await createAnnotation({ ...input, id: annotationSave.current.id });
      }
      setAnnotations(items => upsert(items, saved));
      setSelectedAnnotationId(saved.id);
      closeAnnotationDraft();
    }, '标注已保存');
  }

  function setAnnotationVisible(annotation: MapAnnotation) {
    void commit(async () => {
      const saved = await updateAnnotation(annotation.id, { visible: !annotation.visible });
      setAnnotations(items => upsert(items, saved));
      setAnnotationDraft(draft => draft?.id === saved.id ? { ...draft, visible: saved.visible } : draft);
    }, annotation.visible ? '标注已隐藏' : '标注已显示');
  }

  function removeAnnotation(annotation: MapAnnotation) {
    if (!window.confirm(`删除标注「${annotation.title}」？`)) return;
    void commit(async () => {
      await deleteAnnotation(annotation.id);
      setAnnotations(items => items.filter(item => item.id !== annotation.id));
      if (annotationDraft?.id === annotation.id) closeAnnotationDraft();
      setSelectedAnnotationId(id => id === annotation.id ? null : id);
    }, '标注已删除');
  }

  function focusAnnotation(annotation: MapAnnotation) {
    setSelectedAnnotationId(annotation.id);
    controller?.focusWorkspacePoints([vertexFromAnnotation(annotation)]);
  }

  function setStartFromAnnotation(annotation: MapAnnotation) {
    if (measurementDraft?.vertices.length && !window.confirm('从此标注重新开始并清除本次未保存结果？')) return false;
    measurementSave.current = null;
    setMeasurementDraft(null);
    setMeasurementSeed(vertexFromAnnotation(annotation));
    setSelectedMeasurementId(null);
    setHighlightedSegment(null);
    setNotice('');
    setActionError('');
    controller?.focusWorkspacePoints([vertexFromAnnotation(annotation)]);
    return true;
  }

  function beginMeasurement(mode: MeasurementMode) {
    if (measurementDraft && measurementDraft.vertices.length > 1 &&
      !window.confirm('开始新测量并清除本次未保存结果？')) return;
    const origin = measurementSeed ?? (measurementDraft?.vertices.length === 1 ? measurementDraft.vertices[0] : undefined);
    measurementSave.current = null;
    setMeasurementDraft({ mode, vertices: origin ? [origin] : [], finished: false, title: '', note: '' });
    setMeasurementSeed(null);
    setSelectedMeasurementId(null);
    setHighlightedSegment(null);
    setActionError('');
    setNotice('');
  }

  function resumeMeasurement() {
    setSelectedMeasurementId(null);
    setHighlightedSegment(null);
  }

  function undoMeasurementPoint() {
    setMeasurementDraft(draft => draft && { ...draft, finished: false, vertices: draft.vertices.slice(0, -1) });
    setHighlightedSegment(null);
  }

  function changeMeasurement(fields: { title?: string; note?: string }) {
    setMeasurementDraft(draft => draft && { ...draft, ...fields });
  }

  function saveMeasurementDraft() {
    if (!measurementDraft?.finished || measurementDraft.vertices.length < 2) return;
    if (!measurementDraft.title.trim()) {
      setActionError('请输入测量名称。');
      return;
    }
    const input = {
      title: measurementDraft.title.trim(),
      note: measurementDraft.note.trim(),
      mode: measurementDraft.mode,
      vertices: measurementDraft.vertices,
      visible: true,
    };
    void commit(async () => {
      const key = JSON.stringify(input);
      if (measurementSave.current?.input !== key) measurementSave.current = { input: key, id: crypto.randomUUID() };
      const saved = await createMeasurement({ ...input, id: measurementSave.current.id });
      setMeasurements(items => upsert(items, saved));
      setMeasurementDraft(null);
      measurementSave.current = null;
      setSelectedMeasurementId(saved.id);
    }, '测量结果已保存');
  }

  function selectMeasurement(measurement: DistanceMeasurement) {
    setSelectedMeasurementId(measurement.id);
    setHighlightedSegment(null);
    controller?.focusWorkspacePoints(measurement.vertices);
  }

  function setMeasurementVisible(measurement: DistanceMeasurement) {
    void commit(async () => {
      const saved = await updateMeasurement(measurement.id, { visible: !measurement.visible });
      setMeasurements(items => upsert(items, saved));
    }, measurement.visible ? '测量线已隐藏' : '测量线已显示');
  }

  function removeMeasurement(measurement: DistanceMeasurement) {
    if (!window.confirm(`删除测量「${measurement.title}」？`)) return;
    void commit(async () => {
      await deleteMeasurement(measurement.id);
      setMeasurements(items => items.filter(item => item.id !== measurement.id));
      setSelectedMeasurementId(id => id === measurement.id ? null : id);
      setHighlightedSegment(null);
    }, '测量结果已删除');
  }

  return {
    annotations, measurements, annotationDraft, annotationPicking, measurementDraft, measurementSeed,
    selection: { annotationId: selectedAnnotationId, measurement: selectedMeasurement, segment: highlightedSegment },
    currentDistance: activeMeasurement, hoveredVertex: preview, labelsVisible, setLabelsVisible,
    status: {
      loading, busy, actionError, loadError, notice,
      reload: () => { if (!busyRef.current && !loading) setRefresh(value => value + 1); },
    },
    annotation: {
      start: startAnnotation, edit: editAnnotation, change: changeAnnotation, cancel: closeAnnotationDraft,
      pick: () => setAnnotationPicking(value => !value), save: saveAnnotationDraft, focus: focusAnnotation,
      toggleVisibility: setAnnotationVisible, remove: removeAnnotation, measureFrom: setStartFromAnnotation,
    },
    measurement: {
      begin: beginMeasurement, resume: resumeMeasurement, undo: undoMeasurementPoint, finish: finishMeasurement,
      cancel: clearMeasurement, change: changeMeasurement, save: saveMeasurementDraft, select: selectMeasurement,
      selectSegment: (index: number) => setHighlightedSegment(current => current === index ? null : index),
      toggleVisibility: setMeasurementVisible, remove: removeMeasurement,
    },
  };
}

export type MapWorkspace = ReturnType<typeof useMapWorkspace>;
