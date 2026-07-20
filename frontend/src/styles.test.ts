import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(process.cwd() + '/src/styles.css', 'utf8');

describe('operator terminal stylesheet contract', () => {
  it('uses the approved palette, native type, and 36px desktop rows', () => {
    for (const token of [
      '--canvas: #0b0d0e',
      '--pane: #111416',
      '--raised: #181d20',
      '--separator: #2a3034',
      '--text: #eef1f2',
      '--secondary: #8e979d',
      '--selection: #5b9bd5',
      '--positive: #65ba8c',
      '--negative: #d96666',
      '--warning: #d2a653',
      '-apple-system',
      'ui-monospace',
      'height: 36px',
    ]) {
      expect(styles).toContain(token);
    }
  });

  it('pins shell and optional pane bodies to their flexible final rows', () => {
    expect(styles).toMatch(
      /\.app-shell\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s,
    );
    expect(styles).toMatch(/\.app-shell__workspace\s*\{[^}]*grid-row:\s*3/s);
    expect(styles).toMatch(
      /\.pane\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s,
    );
    expect(styles).toMatch(/\.pane__body\s*\{[^}]*grid-row:\s*3/s);
  });

  it('defines exact mobile, compact, and wide boundaries', () => {
    expect(styles).toMatch(/@media\s*\(max-width:\s*899px\)/);
    expect(styles).toMatch(
      /@media\s*\(min-width:\s*900px\)\s*and\s*\(max-width:\s*1015px\)/,
    );
    expect(styles).toMatch(/@media\s*\(min-width:\s*1016px\)/);
  });

  it('contains no decorative or motion treatment', () => {
    expect(styles).not.toMatch(
      /gradient|box-shadow|text-shadow|backdrop-filter|\bfilter\s*:|@keyframes|animation\s*:|transition(?:-[a-z]+)?\s*:/i,
    );
    expect(styles).not.toMatch(/border-radius:\s*(?:[5-9]|[1-9]\d+)px/i);
  });

  it('gives mobile controls and interactive table rows 44px targets', () => {
    expect(styles).toMatch(
      /@media\s*\(max-width:\s*899px\)[\s\S]*\.pane__tabs button[\s\S]*min-height:\s*44px/,
    );
    expect(styles).toMatch(
      /@media\s*\(max-width:\s*899px\)[\s\S]*\.confirmation__actions button[\s\S]*min-height:\s*44px/,
    );
    expect(styles).toMatch(
      /@media\s*\(max-width:\s*899px\)[\s\S]*\.exclude-item button[\s\S]*min-height:\s*44px/,
    );
    expect(styles).toMatch(
      /@media\s*\(max-width:\s*899px\)[\s\S]*\.data-table tbody > tr\[tabindex\][\s\S]*height:\s*44px/,
    );
  });

  it('fits the complete mobile safety strip into a twelve-column grid without horizontal scrolling', () => {
    const mobileStart = styles.indexOf('@media (max-width: 899px)');
    const mobileStyles = styles.slice(mobileStart);
    const spanFor = (slot: string) => {
      const match = mobileStyles.match(
        new RegExp(
          `\\.operational-header__state-item--${slot}\\s*\\{[^}]*grid-column:\\s*span\\s+(\\d+)`,
          's',
        ),
      );
      return Number(match?.[1] ?? 0);
    };

    expect(mobileStyles).toMatch(
      /\.operational-header__state\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(12,\s*minmax\(0,\s*1fr\)\)[^}]*overflow-x:\s*hidden/s,
    );
    expect(spanFor('mode') + spanFor('session') + spanFor('broker')).toBe(12);
    expect(spanFor('refresh') + spanFor('risk')).toBe(12);
    expect(spanFor('risk')).toBeGreaterThan(spanFor('refresh'));
    expect(mobileStyles).toMatch(
      /\.operational-header__state-item--risk\s*\{[^}]*white-space:\s*normal[^}]*overflow-wrap:\s*break-word/s,
    );
    expect(mobileStyles).toMatch(
      /\.operational-header__state\s*>\s*\.operational-header__state-item--feed,\s*\.operational-header__state\s*>\s*\.operational-header__state-item--clock\s*\{[^}]*display:\s*none/s,
    );
  });

  it('keeps long table identifiers readable inside local horizontal overflow', () => {
    expect(styles).toMatch(
      /\.data-table-wrap\s*\{[^}]*overflow-x:\s*auto/s,
    );
    expect(styles).toMatch(
      /\.data-table td\s*\{[^}]*overflow-wrap:\s*break-word/s,
    );
    expect(styles).not.toMatch(
      /\.data-table td\s*\{[^}]*overflow-wrap:\s*anywhere/s,
    );
  });
});
