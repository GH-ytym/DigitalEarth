import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { Icon } from '../../components/Icon';
import { normalizedQuery, searchPlaces } from './search';
import { placeHierarchy, placeKindLabel } from './types';
import type { PlaceResult } from './types';

interface Props {
  active: boolean;
  disabled: boolean;
  selectedPlaceId?: number;
  onSelect: (place: PlaceResult) => void;
}

export function PlaceSearchPanel({ active, disabled, selectedPlaceId, onSelect }: Props) {
  const [query, setQuery] = useState('');
  const [phase, setPhase] = useState<'idle' | 'loading' | 'ready' | 'error' | 'invalid'>('idle');
  const [results, setResults] = useState<PlaceResult[]>([]);
  const [error, setError] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const [refresh, setRefresh] = useState(0);
  const [composing, setComposing] = useState(false);
  const immediate = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (activeIndex >= 0) list.current?.children.item(activeIndex)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  useEffect(() => {
    if (!active || composing) return;
    const length = Array.from(normalizedQuery(query)).length;
    setResults([]);
    setActiveIndex(-1);
    setError('');
    if (length < 2) { setPhase('idle'); return; }
    if (length > 100) { setPhase('invalid'); return; }
    const controller = new AbortController();
    setPhase('loading');
    const delay = immediate.current ? 0 : 300;
    immediate.current = false;
    const timer = window.setTimeout(() => {
      void searchPlaces(query.trim(), controller.signal).then((places) => {
        if (controller.signal.aborted) return;
        setResults(places);
        setPhase('ready');
      }).catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setError(reason instanceof Error ? reason.message : '查询失败，请稍后重试。');
        setPhase('error');
      });
    }, delay);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query, active, refresh, composing]);

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (composing) return;
    immediate.current = true;
    setRefresh((value) => value + 1);
  }

  function select(place: PlaceResult) {
    if (!disabled) onSelect(place);
  }

  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) {
      if (event.key === 'Enter') event.preventDefault();
      return;
    }
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && results.length > 0) {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((index) => index < 0 ? (step > 0 ? 0 : results.length - 1) : (index + step + results.length) % results.length);
    } else if (event.key === 'Enter' && activeIndex >= 0 && results[activeIndex]) {
      event.preventDefault();
      select(results[activeIndex]);
    } else if (event.key === 'Escape') {
      setActiveIndex(-1);
    }
  }

  return (
    <div className="place-search">
      <form className="place-search-form" onSubmit={submit} role="search" aria-label="地名搜索">
        <div className="place-search-input">
          <Icon name="search" size={18} />
          <input ref={input} role="combobox" aria-label="搜索地名" placeholder="搜索城市、地区或地名"
            aria-autocomplete="list" aria-controls="place-results" aria-expanded={phase === 'ready' && results.length > 0}
            aria-activedescendant={activeIndex >= 0 ? `place-option-${activeIndex}` : undefined}
            autoComplete="off" value={query} maxLength={200}
            onChange={(event) => { immediate.current = false; setQuery(event.target.value); }}
            onKeyDown={keyDown} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} />
          {query && <button className="icon-button" type="button" aria-label="清空地名" onClick={() => { setQuery(''); input.current?.focus(); }}><Icon name="close" size={15} /></button>}
        </div>
        <button className="place-submit" type="submit" aria-label="搜索">搜索</button>
      </form>
      <div className="place-search-status" role="status" aria-live="polite">
        {phase === 'idle' && <p>输入至少 2 个字符，查找地点并定位。</p>}
        {phase === 'invalid' && <p>请输入 2–100 个有效字符。</p>}
        {phase === 'loading' && <p><span className="loading-ring" />正在查询地名…</p>}
        {phase === 'ready' && results.length > 0 && <p>找到 {results.length} 个候选 · 选择地点定位</p>}
        {phase === 'ready' && results.length === 0 && <p>未找到匹配地点，请尝试其他名称或别名。</p>}
      </div>
      {phase === 'error' && <div className="place-search-error" role="alert"><p>{error}</p><button className="text-button" onClick={() => submit()}>重新查询<Icon name="arrow" size={14} /></button></div>}
      <ul ref={list} className="place-results" id="place-results" role="listbox" aria-label="地名候选" aria-busy={phase === 'loading'}>
        {results.map((place, index) => (
          <li key={place.geoname_id} id={`place-option-${index}`} role="option"
            aria-selected={activeIndex === index} aria-disabled={disabled}
            className={selectedPlaceId === place.geoname_id ? 'is-selected' : ''}
            onMouseMove={() => setActiveIndex(index)} onClick={() => { setActiveIndex(index); select(place); }}>
            <div className="place-result-heading"><strong>{place.name}</strong><span className="place-source">本地库</span></div>
            <div className="place-hierarchy">{placeHierarchy(place)}</div>
            <div className="place-result-detail"><span>{placeKindLabel(place)}</span>{place.approximate_representative_point && <span>近似代表点</span>}{selectedPlaceId === place.geoname_id && <span className="place-selected-label"><Icon name="check" size={12} />已定位</span>}</div>
          </li>
        ))}
      </ul>
      {disabled && results.length > 0 && <p className="quiet-description">场景就绪后可选择地点定位。</p>}
    </div>
  );
}
