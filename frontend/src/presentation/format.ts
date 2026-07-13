export function formatEtTimestamp(iso: string): string {
  const value = new Date(iso);
  if (!Number.isFinite(value.getTime())) return 'Not recorded';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(value) + ' ET';
}

export function formatRefreshAge(at: number | null, now = Date.now()): string {
  if (at === null) return 'No successful refresh';
  const seconds = Math.max(0, Math.floor((now - at) / 1_000));
  if (seconds < 60) return seconds + 's ago';
  const minutes = Math.floor(seconds / 60);
  return minutes + 'm ago';
}

export function formatUsd(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'Not available';
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export function formatPercent(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'Not recorded';
  return (value * 100).toFixed(0) + '%';
}

export function sentenceCase(value: string): string {
  const spaced = value.replace(/[_-]+/g, ' ').trim();
  return spaced === '' ? 'Not recorded' : spaced[0].toUpperCase() + spaced.slice(1);
}
