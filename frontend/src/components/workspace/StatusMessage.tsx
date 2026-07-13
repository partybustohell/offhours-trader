import type { ReactNode } from 'react';

export type StatusTone =
  | 'loading'
  | 'stale'
  | 'empty'
  | 'success'
  | 'warning'
  | 'error';

export interface StatusMessageProps {
  tone: StatusTone;
  children: ReactNode;
  announce?: 'polite' | 'assertive' | 'off';
}

export function StatusMessage({
  tone,
  children,
  announce = 'off',
}: StatusMessageProps) {
  const role =
    announce === 'assertive'
      ? 'alert'
      : announce === 'polite'
        ? 'status'
        : undefined;

  return (
    <div
      className={'status-message status-message--' + tone}
      role={role}
      aria-live={announce === 'off' ? undefined : announce}
    >
      {children}
    </div>
  );
}
