import { useEffect, useMemo, useState } from 'react';

export interface LinkedSelection<T> {
  selectedKey: string | null;
  selectedItem: T | null;
  detailOpen: boolean;
  select(item: T): void;
  closeDetail(): void;
}

export function useLinkedSelection<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
): LinkedSelection<T> {
  const [selectedKey, setSelectedKey] = useState<string | null>(() =>
    items[0] ? keyOf(items[0]) : null,
  );
  const [detailOpen, setDetailOpen] = useState(false);

  useEffect(() => {
    const surviving =
      selectedKey !== null && items.some((item) => keyOf(item) === selectedKey);
    if (!surviving) {
      setSelectedKey(items[0] ? keyOf(items[0]) : null);
      if (items.length === 0) setDetailOpen(false);
    }
  }, [items, keyOf, selectedKey]);

  const selectedItem = useMemo(
    () => items.find((item) => keyOf(item) === selectedKey) ?? null,
    [items, keyOf, selectedKey],
  );

  return {
    selectedKey,
    selectedItem,
    detailOpen,
    select(item) {
      setSelectedKey(keyOf(item));
      setDetailOpen(true);
    },
    closeDetail() {
      setDetailOpen(false);
    },
  };
}
