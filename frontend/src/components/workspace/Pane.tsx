import type { KeyboardEvent, ReactNode } from 'react';

export interface PaneTab {
  id: string;
  label: string;
}

export interface PaneProps {
  id: string;
  title: string;
  ariaLabel?: string;
  subtitle?: ReactNode;
  toolbar?: ReactNode;
  tabs?: readonly PaneTab[];
  activeTab?: string;
  onTabChange?(id: string): void;
  overflow?: 'auto' | 'hidden' | 'visible';
  className?: string;
  children: ReactNode;
}

export function Pane({
  id,
  title,
  ariaLabel,
  subtitle,
  toolbar,
  tabs,
  activeTab,
  onTabChange,
  overflow = 'auto',
  className = '',
  children,
}: PaneProps) {
  const headingId = id + '-title';
  const panelId = id + '-panel';

  const onTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    if (!tabs || tabs.length === 0) return;

    let nextIndex: number;
    if (event.key === 'ArrowLeft') {
      nextIndex = (index - 1 + tabs.length) % tabs.length;
    } else if (event.key === 'ArrowRight') {
      nextIndex = (index + 1) % tabs.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = tabs.length - 1;
    } else {
      return;
    }

    event.preventDefault();
    const tabButtons = event.currentTarget.parentElement?.querySelectorAll(
      '[role="tab"]',
    );
    const nextButton = tabButtons?.item(nextIndex);
    if (nextButton instanceof HTMLElement) nextButton.focus();
    if (nextIndex !== index) onTabChange?.(tabs[nextIndex].id);
  };

  return (
    <section
      className={'pane ' + className}
      aria-labelledby={ariaLabel ? undefined : headingId}
      aria-label={ariaLabel}
    >
      <header className="pane__header">
        <div className="pane__heading">
          <h2 id={headingId}>{title}</h2>
          {subtitle ? <div className="pane__subtitle">{subtitle}</div> : null}
        </div>
        {toolbar ? <div className="pane__toolbar">{toolbar}</div> : null}
      </header>
      {tabs && tabs.length > 0 ? (
        <div className="pane__tabs" role="tablist" aria-label={title + ' views'}>
          {tabs.map((tab, index) => {
            const selected = tab.id === activeTab;
            return (
              <button
                key={tab.id}
                id={id + '-tab-' + tab.id}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={panelId}
                tabIndex={selected ? 0 : -1}
                onClick={() => onTabChange?.(tab.id)}
                onKeyDown={(event) => onTabKeyDown(event, index)}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      ) : null}
      <div
        id={panelId}
        className="pane__body"
        role={tabs && tabs.length > 0 ? 'tabpanel' : undefined}
        aria-labelledby={tabs && activeTab ? id + '-tab-' + activeTab : undefined}
        style={{ overflow }}
      >
        {children}
      </div>
    </section>
  );
}
