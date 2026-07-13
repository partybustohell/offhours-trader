import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SemanticText, type SemanticTone } from './SemanticText';

describe('SemanticText', () => {
  it.each<SemanticTone>(['positive', 'negative', 'warning', 'neutral'])(
    'renders visible text with the %s semantic tone',
    (tone) => {
      render(<SemanticText tone={tone}>{tone} state</SemanticText>);

      expect(screen.getByText(tone + ' state')).toHaveClass(
        'semantic-text',
        'semantic-text--' + tone,
      );
    },
  );
});
