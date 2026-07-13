import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useLinkedSelection } from './useLinkedSelection';

interface Item {
  symbol: string;
}

describe('useLinkedSelection', () => {
  it('selects the first row, preserves a surviving key, falls back, and clears', () => {
    const { result, rerender } = renderHook(
      ({ items }: { items: Item[] }) =>
        useLinkedSelection(items, (item) => item.symbol),
      { initialProps: { items: [{ symbol: 'AMD' }, { symbol: 'WBD' }] } },
    );
    expect(result.current.selectedKey).toBe('AMD');

    act(() => result.current.select({ symbol: 'WBD' }));
    expect(result.current.selectedKey).toBe('WBD');
    expect(result.current.detailOpen).toBe(true);

    rerender({ items: [{ symbol: 'WBD' }, { symbol: 'NVDA' }] });
    expect(result.current.selectedKey).toBe('WBD');

    rerender({ items: [{ symbol: 'NVDA' }] });
    expect(result.current.selectedKey).toBe('NVDA');

    rerender({ items: [] });
    expect(result.current.selectedKey).toBeNull();
    expect(result.current.selectedItem).toBeNull();
    expect(result.current.detailOpen).toBe(false);
  });

  it('closes detail without clearing the linked row', () => {
    const items = [{ symbol: 'AMD' }, { symbol: 'WBD' }];
    const { result } = renderHook(() =>
      useLinkedSelection(items, (item) => item.symbol),
    );

    act(() => result.current.select(items[1]));
    act(() => result.current.closeDetail());

    expect(result.current.selectedKey).toBe('WBD');
    expect(result.current.selectedItem).toEqual(items[1]);
    expect(result.current.detailOpen).toBe(false);
  });
});
