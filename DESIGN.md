# Design System: offhours · Instrument

A source-of-truth design language for generating new screens (Stitch or hand-built)
that match the offhours-trader dashboard. Encodes the "Instrument" aesthetic — a
precision-measurement console: aerospace ground-station meets Swiss research
terminal. Read every section as a rule, not a suggestion.

---

## 1. Visual Theme & Atmosphere

**Density: 8 (Cockpit Dense).** This is a live trading terminal, not a marketing
site. Information-per-pixel is high but never cramped — dense-but-breathing.
Hairline dividers do the structural work; whitespace is measured, not generous.

**Variance: 4 (Offset, structured).** A disciplined grid with intentional
asymmetry (1.4fr/1fr splits, KPI tile rows, sticky rails) — not chaotic, not
rigidly symmetric. No decorative overlap; every element owns a clean spatial zone.

**Motion: 5 (Fluid, restrained).** One quick staggered entrance per view; a single
perpetual "the instrument is live" signal (a scanning hairline + a pulsing status
dot). Motion confirms liveness and hierarchy — it never performs.

The feeling: a calm, serious instrument someone designed on purpose. Clinical
precision with a warm amber pulse. It should read as *equipment*, not *product*.

---

## 2. Color Palette & Roles

A near-monochrome charcoal field where a single amber hairline carries the brand,
and green/red are reserved strictly for market direction and P&L sign.

**Surfaces (layered charcoal, never pure black):**
- **Field Black** (`#0a0b0e`) — app canvas; carries a faint 64px measurement grid + a top-right amber vignette
- **Well** (`#0c0e12`) — recessed panels, inputs, expanded rows
- **Surface** (`#101319`) — card fill (top of a subtle vertical gradient to Well)
- **Raised** (`#14181f`) — hover fill on rows and nav links
- **Raised-2** (`#191e26`) — track backgrounds (bars, sliders)

**Structure lines:**
- **Line** (`#232a34`) — primary 1px borders, card edges, table header rules
- **Line Soft** (`#191e26`) — internal row dividers, faint grid lines
- **Line Hair** (`#2c343f`) — hover borders, tick marks, the zero baseline

**Ink:**
- **Text** (`#e9edf3`) — primary readouts, tickers, values
- **Muted Steel** (`#929cab`) — secondary text, nav labels, prose body
- **Faint** (`#5c6675`) — metadata, timestamps, notes, axis labels
- **Ghost** (`#3a4250`) — index numerals, disabled marks

**Accent (exactly one) — Amber:**
- **Amber** (`#e0a94a`, saturation ~68%) — the brand hairline: active nav edge, conviction fills, focus rings, primary CTA border/fill-tint, the scanning telemetry line
- **Amber Bright** (`#f2c064`) — active text, hover state of amber elements

**Semantic (reserved — direction & P&L only, never "series color"):**
- **Green** (`#46d183`) — long positions, positive P&L, the live status dot
- **Red** (`#f16860`) — short positions, negative P&L, risk-gate rejections, live mode
- **Blue** (`#64a2ff`) — paper-mode badge, informational state only

**Bans:** no pure black (`#000000`); no purple/violet anywhere; no neon or
oversaturated fills; no gradient text; green/red are never repurposed for
categorical identity — they mean sign and side, full stop.

---

## 3. Typography Rules

Three families, mapped to the *job the text does* — this mapping IS the concept.

- **Structure → Archivo** (700–800 display, 500–600 labels). View titles
  (`clamp`-scaled, weight-driven, tracking `-0.02em`), section labels (uppercase,
  `letter-spacing 0.16em`, 9–10px), nav links, table headers. Never screaming —
  hierarchy through weight and color, not size alone.
- **Data → IBM Plex Mono** (400–600). ALL numerics, tickers, telemetry, timestamps,
  prices, table cells — always `font-variant-numeric: tabular-nums`. Density is
  high, so numbers are always monospace (per the >7 density override).
- **Reasoning → Newsreader** (a distinctive modern serif, 400/500 + italic).
  **Scoped exclusively to editorial narrative prose** — the analysts' thesis
  arguments and invalidation conditions, which read like a research note. This is
  the deliberate, signature exception to the dashboard serif ban: serif is *never*
  used for UI chrome, labels, controls, or data — only for human-authored argument
  set at 13.5–15px / 1.6 leading, max ~65ch. If a screen has no editorial prose, it
  uses zero serif.

**Bans:** Inter, Roboto, Arial, system-ui for anything but fallback; Space Grotesk
(overused); generic serifs (Times, Georgia, Garamond, Palatino); any serif on
labels, buttons, tables, or numeric data.

---

## 4. Component Stylings

- **Cards:** flat `#101319→#0c0e12` gradient fill, 1px `Line` border, 3px radius
  (sharp, instrument-like — not the soft 2.5rem web card). A 2px semantic left edge
  (`edge-amber/green/red`) when the card carries a status or direction. Header row:
  uppercase Archivo label left, mono metadata right, hairline divider under.
  High-density regions drop the card entirely for `border-top` dividers.
- **KPI tiles:** a responsive `auto-fit minmax(150px,1fr)` row of stat wells — big
  mono value (25px), uppercase micro-label above, faint mono note below. This is an
  intentional dense stat pattern, distinct from (and not) the banned 3-equal-card
  feature row.
- **Buttons:** ghost by default — 1px `Line Hair` border, Archivo 500, no fill.
  Hover shifts text/border to amber with a faint `amber-dim` wash. Primary = amber
  text + `amber-line` border + `amber-dim` fill. Danger (Halt) = red variant. Flat,
  tactile, no outer glow, no custom cursor.
- **Inputs:** `Well` fill, 1px `Line`, mono, tabular numerals; focus ring = 1px
  `amber-line`. Label (mono, 10px) sits above; error text below in red. No floating
  labels. Range sliders and checkboxes use `accent-color: amber`.
- **Pills & badges:** 2px-radius, mono, uppercase micro-caps. `long`=green outline,
  `short`=red outline, mode badges tinted (paper=blue, live=red).
- **Conviction bar:** 4px `Raised-2` track, amber gradient fill that animates its
  width from 0 on mount; mono value right-aligned.
- **Tables:** Archivo uppercase headers on a `Line` rule; mono tabular cells; rows
  gain a `Raised` wash on hover; right-align all numerics.
- **Loaders / empty states:** never a spinner. Empty = a composed, plain-spoken line
  in `Faint` mono that states the real posture ("Flat — no open positions.",
  "Nothing cleared the bar. Default posture: do nothing.").

---

## 5. Layout Principles

- **App shell = CSS Grid** `[208px rail | 1fr stage]`. The stage is a flex column:
  a fixed 52px telemetry status bar on top, a single scrolling view below. No
  `calc()` percentage math anywhere.
- **Left nav rail** (persistent): brand mark + pulsing glyph, numbered view links
  (`01`–`06`) with an amber active edge, a footer readout (mode / feed / threshold).
- **Telemetry bar** (persistent): cell readouts — Mode · Session · Equity · Halt ·
  local clock — divided by hairlines, actions (Pipeline / Tick / Halt) right-aligned,
  a scanning amber hairline along the bottom edge.
- **Views** are overview-first and drill-down (Overview → Thesis / Positions /
  Backtest / Config / Audit), hash-routed. Each opens with an Archivo title + a
  one-line muted description + a mono tag, then content.
- **Grids:** asymmetric `1.4fr/1fr` and even `1fr/1fr` splits; stat rows via
  `auto-fit`. No overlapping, absolutely-stacked content. Contain wide content
  (tables, charts) in their own `overflow-x` scroller — the page body never scrolls
  horizontally.

---

## 6. Responsive Rules

- Below **900px**, the nav rail is hidden and every multi-column grid collapses to a
  single column. No horizontal page overflow, ever.
- View titles scale with `clamp()`; body/data never below 12px mono / 14px prose.
- Interactive targets ≥ 44px on touch; full-height uses the viewport unit, never a
  fixed `h-screen`.
- Wide tables and the P&L chart stay in their own horizontal scrollers on narrow
  screens rather than reflowing.

---

## 7. Motion & Interaction

- **Entrance:** one staggered cascade per view — children rise 6px + fade over 0.32s
  with a `calc(var(--i) * 32ms)` delay. Quick enough that navigation never flashes
  blank.
- **Perpetual (exactly two, both meaning "live"):** the telemetry bar's amber
  scanning hairline (6s linear sweep) and the session status dot's green blip pulse.
  The nav glyph has a slow 3.5s scale pulse. Nothing else loops.
- **Micro-interactions:** conviction bars grow from 0; nav/rows cross-fade fills on
  hover; the active nav edge carries a *single, subtle* amber glow — the only glow in
  the system, reserved for the live-location indicator, never decorative.
- **Performance:** animate only `transform` and `opacity` (plus width on the one-shot
  conviction fill). Background grid/vignette live on the fixed body layer. Everything
  is wrapped by a `prefers-reduced-motion` guard that flattens all of it.

---

## 8. Anti-Patterns (Banned)

- No emojis, anywhere.
- No Inter / Roboto / Arial / system-ui as a primary face; no Space Grotesk.
- No generic serifs; no serif at all on UI chrome, labels, controls, or data —
  serif only for editorial narrative prose.
- No pure black `#000000` — charcoal surfaces only.
- No purple, violet, or "AI neon" anything; no oversaturated accents; more than one
  accent hue is banned.
- No neon/outer-glow shadows (the single subtle amber active-nav glow is the sole,
  functional exception).
- No gradient text on headings; no custom mouse cursors.
- No overlapping / absolutely-stacked content — clean spatial zones always.
- No 3-equal-card feature rows; no `calc()` percentage layout hacks; no dual-axis
  charts (P&L uses one axis, sign encoded by direction + color + value together).
- No spinners for loading; no bare "No data" empty states — state the real posture.
- No AI copy clichés ("Elevate", "Seamless", "Unleash", "Next-Gen"); no fake round
  numbers; no placeholder names ("Acme", "John Doe"); no broken image links.
- No "scroll to explore" / bouncing-chevron filler.
