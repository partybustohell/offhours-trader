import { useEffect, useState } from 'react';

export type ViewId = 'overview' | 'thesis' | 'positions' | 'backtest' | 'config' | 'audit';

export interface RouteItem {
  id: ViewId;
  label: 'Monitor' | 'Research' | 'Positions' | 'Backtest' | 'Configuration' | 'Audit';
  mobile: 'primary' | 'more';
}

export const ROUTES: readonly RouteItem[] = [
  { id: 'overview', label: 'Monitor', mobile: 'primary' },
  { id: 'thesis', label: 'Research', mobile: 'primary' },
  { id: 'positions', label: 'Positions', mobile: 'primary' },
  { id: 'backtest', label: 'Backtest', mobile: 'more' },
  { id: 'config', label: 'Configuration', mobile: 'more' },
  { id: 'audit', label: 'Audit', mobile: 'more' },
];

const ids = ROUTES.map((route) => route.id);

function fromHash(): ViewId {
  const value = window.location.hash.replace(/^#\/?/, '') as ViewId;
  return ids.includes(value) ? value : 'overview';
}

export function useHashView(): [ViewId, (view: ViewId) => void] {
  const [view, setView] = useState<ViewId>(fromHash);
  useEffect(() => {
    const onHashChange = () => setView(fromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  return [
    view,
    (next) => {
      if (fromHash() === next) {
        setView(next);
      } else {
        window.location.hash = '/' + next;
      }
    },
  ];
}
