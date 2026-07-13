import type { ReactNode } from 'react';

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
  return (
    <div className="master-detail" data-detail-open={detailOpen}>
      <div className="master-detail__master">{master}</div>
      <div
        className="master-detail__detail"
        role="group"
        aria-label={detailLabel}
        aria-hidden={detailOpen ? false : undefined}
      >
        <button className="master-detail__back" type="button" onClick={onDetailClose}>
          Back to candidates
        </button>
        {detail}
      </div>
    </div>
  );
}
