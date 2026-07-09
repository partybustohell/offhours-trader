import { useEffect, useState } from 'react';

export type ViewId = 'overview' | 'thesis' | 'positions' | 'backtest' | 'config' | 'audit';

const IDS: ViewId[] = ['overview', 'thesis', 'positions', 'backtest', 'config', 'audit'];

function fromHash(): ViewId {
  const h = window.location.hash.replace(/^#\/?/, '') as ViewId;
  return IDS.includes(h) ? h : 'overview';
}

/** Minimal hash router — no dependency, back/forward and bookmarks work. */
export function useHashView(): [ViewId, (v: ViewId) => void] {
  const [view, setView] = useState<ViewId>(fromHash);
  useEffect(() => {
    const on = () => setView(fromHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const go = (v: ViewId) => {
    window.location.hash = `/${v}`;
  };
  return [view, go];
}
