import { useEffect, useRef, useState } from 'react';
import type { RouteItem, ViewId } from '../../router';

export interface WorkspaceTabsProps {
  routes: readonly RouteItem[];
  activeView: ViewId;
  onNavigate(view: ViewId): void;
}

const moreRoutesId = 'mobile-more-routes';

export function WorkspaceTabs({
  routes,
  activeView,
  onNavigate,
}: WorkspaceTabsProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreButton = useRef<HTMLButtonElement>(null);
  const morePanel = useRef<HTMLDivElement>(null);
  const firstSecondary = useRef<HTMLAnchorElement>(null);
  const primaryRoutes = routes.filter((route) => route.mobile === 'primary');
  const secondaryRoutes = routes.filter((route) => route.mobile === 'more');
  const secondaryActive = secondaryRoutes.find((route) => route.id === activeView);

  useEffect(() => {
    if (!moreOpen) return;
    const timer = window.setTimeout(() => firstSecondary.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [moreOpen]);

  useEffect(() => {
    const restoreFocus = moreOpen
      && morePanel.current?.contains(document.activeElement) === true;
    setMoreOpen(false);
    if (restoreFocus) {
      window.setTimeout(() => moreButton.current?.focus(), 0);
    }
  }, [activeView]);

  const navigate = (view: ViewId, restoreMoreFocus = false) => {
    setMoreOpen(false);
    if (restoreMoreFocus) {
      window.setTimeout(() => moreButton.current?.focus(), 0);
    }
    onNavigate(view);
  };

  const closeAndRestoreFocus = () => {
    setMoreOpen(false);
    window.setTimeout(() => moreButton.current?.focus(), 0);
  };

  return (
    <>
      <nav className="workspace-tabs" aria-label="Workspace routes">
        {routes.map((route) => (
          <a
            key={route.id}
            href={'#/' + route.id}
            aria-current={route.id === activeView ? 'page' : undefined}
            onClick={(event) => {
              event.preventDefault();
              navigate(route.id);
            }}
          >
            {route.label}
          </a>
        ))}
      </nav>
      <nav
        className="mobile-navigation"
        aria-label="Mobile workspace routes"
        onKeyDown={(event) => {
          if (moreOpen && event.key === 'Escape') {
            event.preventDefault();
            closeAndRestoreFocus();
          }
        }}
      >
        {primaryRoutes.map((route) => (
          <a
            key={route.id}
            href={'#/' + route.id}
            aria-current={route.id === activeView ? 'page' : undefined}
            onClick={(event) => {
              event.preventDefault();
              navigate(route.id);
            }}
          >
            {route.label}
          </a>
        ))}
        <button
          ref={moreButton}
          type="button"
          aria-label={secondaryActive
            ? 'More routes, current route ' + secondaryActive.label
            : 'More routes'}
          aria-current={secondaryActive ? 'page' : undefined}
          aria-expanded={moreOpen}
          aria-controls={moreRoutesId}
          onClick={() => setMoreOpen((open) => !open)}
        >
          More
        </button>
        {moreOpen ? (
          <div ref={morePanel} id={moreRoutesId} className="mobile-navigation__more">
            {secondaryRoutes.map((route, index) => (
              <a
                key={route.id}
                ref={index === 0 ? firstSecondary : undefined}
                href={'#/' + route.id}
                aria-current={route.id === activeView ? 'page' : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  navigate(route.id, true);
                }}
              >
                {route.label}
              </a>
            ))}
          </div>
        ) : null}
      </nav>
    </>
  );
}
