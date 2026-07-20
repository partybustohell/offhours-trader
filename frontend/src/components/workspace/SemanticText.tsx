import type { ReactNode } from 'react';

export type SemanticTone =
  | 'positive'
  | 'negative'
  | 'warning'
  | 'neutral';

export function SemanticText({
  tone,
  children,
}: {
  tone: SemanticTone;
  children: ReactNode;
}) {
  return (
    <span className={'semantic-text semantic-text--' + tone}>
      {children}
    </span>
  );
}
