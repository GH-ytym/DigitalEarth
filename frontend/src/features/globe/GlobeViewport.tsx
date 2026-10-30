import { useEffect, useRef } from 'react';
import { SceneController } from './SceneController';
import type { SceneSnapshot } from './types';
import 'cesium/Build/Cesium/Widgets/widgets.css';

interface Props {
  onReady: (controller: SceneController | null) => void;
  onSnapshot: (snapshot: SceneSnapshot) => void;
  onError: (message: string) => void;
}

export function GlobeViewport({ onReady, onSnapshot, onError }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    let controller: SceneController;
    try {
      controller = new SceneController(containerRef.current, onSnapshot);
      onReady(controller);
    } catch (error) {
      onError(error instanceof Error ? error.message : '当前浏览器无法初始化三维场景');
      return;
    }
    return () => {
      onReady(null);
      controller.destroy();
    };
  }, [onReady, onSnapshot, onError]);

  return <div className="globe-viewport" ref={containerRef} aria-label="数字地球三维场景" />;
}
