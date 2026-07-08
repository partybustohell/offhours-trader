// Shared shapes for the backtest data store. All timestamps are ISO strings
// as returned by Alpaca; all prices raw (unadjusted) per the plan.

export interface StoredDailyBar {
  t: string; // bar open timestamp (ISO)
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type StoredMinuteBar = StoredDailyBar;

export interface StoredQuote {
  t: string;
  bp: number; // bid price
  bs: number; // bid size (lots)
  ap: number; // ask price
  as: number; // ask size (lots)
}

export interface StoredTrade {
  t: string;
  p: number; // price
  s: number; // size
}

export interface UniverseAsset {
  symbol: string;
  name: string;
  exchange: string;
  tradable: boolean;
  shortable: boolean;
  easy_to_borrow: boolean;
}

export interface CalendarDay {
  date: string; // YYYY-MM-DD
  open: string; // HH:MM
  close: string; // HH:MM
}

export interface SplitAction {
  symbol: string;
  ex_date: string; // YYYY-MM-DD
  old_rate: number;
  new_rate: number;
}

export interface StoredNewsItem {
  headline: string;
  summary: string;
  symbols: string[];
  created_at: string;
  source: string;
}

export interface EpisodeSpec {
  day: string; // YYYY-MM-DD (thesis day D)
  stratum: 'R' | 'H';
  priority: number; // drop-priority order, lower = kept first
  dispersionScore: number;
}

export interface SampleFile {
  seed: number;
  window: { start: string; end: string };
  episodes: EpisodeSpec[]; // in pre-committed priority order
}
