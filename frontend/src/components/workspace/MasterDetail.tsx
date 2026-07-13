import { useEffect, useState, type ReactNode } from 'react';

const mobileDetailBreakpoint = 900;

export interface MasterDetailProps {
  master: ReactNode;
  detail: ReactNode;
  detailOpen: boolean;
  detailLabel: string;
  onDetailClose(): void;
}

export function MasterDetail({
  master,
  detail,
  detailOpen,
  detailLabel,
  onDetailClose,
}: MasterDetailProps) {
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const mobile = viewportWidth < mobileDetailBreakpoint;

  return (
    <div className="master-detail" data-detail-open={detailOpen}>
      <div className="master-detail__master" hidden={mobile && detailOpen}>
        {master}
      </div>
      <div
        className="master-detail__detail"
        role="group"
        aria-label={detailLabel}
        aria-hidden={detailOpen ? false : undefined}
        hidden={mobile && !detailOpen}
      >
        <button className="master-detail__back" type="button" onClick={onDetailClose}>
          Back to candidates
        </button>
        {detail}
      </div>
    </div>
  );
}
