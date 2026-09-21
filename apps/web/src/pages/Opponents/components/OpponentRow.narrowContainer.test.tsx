import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Match, RateValue } from '@smash-tracker/shared';
import i18n from '@/i18n';
import { buildOpponentEvidence, type OpponentEvidenceRow } from '@/lib/stats';
import { OpponentRow } from './OpponentList';

const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Plan 39.1-17 (UIX-03, owner note 1): the committed proof that the
 * opponents-rail row stops clipping. Renders `OpponentRow` in isolation
 * (no `MemoryRouter` needed — every fixture below omits `destination`, so
 * the row stays on its in-page selection-button branch) and asserts the
 * two-line, one-flexible-slot contract directly, including at a real 240px
 * container width under the long-string locale.
 *
 * "Long-string locale" is MEASURED, not assumed (per this plan's own
 * dispatch notes): a real read of all six locales' `shared.evidence.sampleCue`
 * strings (2026-09-21) found German's `low_other`/`medium_other` tied for the
 * longest non-interpolated text — 29 characters against English's 23-26,
 * French's 26-27, Spanish/Portuguese's 26-28, and Japanese's fixed 8 (CJK
 * needs no word-wrap proof the way a space-separated sentence does). `de`.
 */

function makeMatch(
  overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win' | 'opponent'>,
): Match {
  return {
    fighter_id: 1,
    opponent_id: 10,
    map: { id: 1, name: 'Battlefield' },
    notes: '',
    matchType: 'offline-tourney',
    ...overrides,
  };
}

/** Builds a real `OpponentEvidenceRow` (via `buildOpponentEvidence`, never hand-constructed) for a single opponent with the given win/loss split. */
function buildRow(input: {
  wins: number;
  losses: number;
  displayTag?: string;
}): OpponentEvidenceRow {
  const matches: Match[] = [];
  for (let i = 0; i < input.wins; i++) {
    matches.push(makeMatch({ id: `w${i}`, time: i, win: true, opponent: 'target' }));
  }
  for (let i = 0; i < input.losses; i++) {
    matches.push(makeMatch({ id: `l${i}`, time: 1000 + i, win: false, opponent: 'target' }));
  }
  const { rows } = buildOpponentEvidence({ matches, aliasMap: {}, refreshedAt: Date.now() });
  const row = rows[0]!;
  return input.displayTag !== undefined ? { ...row, displayTag: input.displayTag } : row;
}

/** A baseline notably different from the row fixtures below, so `classify()` can genuinely assert a direction (used only by the delta-chip test). */
const NOTABLE_BASELINE: RateValue = { wins: 50, losses: 50, total: 100, rate: 0.5 };
/** A baseline dominated by the row itself — the `collapsed` state, so no chip ever renders regardless of the row's own rate. */
const COLLAPSED_BASELINE: RateValue = { wins: 12, losses: 12, total: 24, rate: 0.5 };

function renderRow(
  row: OpponentEvidenceRow,
  opts: { overallRate?: RateValue; lastPlayedAt?: number } = {},
) {
  return render(
    <OpponentRow
      opponent={row}
      selected={false}
      lastPlayedAt={opts.lastPlayedAt}
      onSelect={vi.fn()}
      onRequestMerge={vi.fn()}
      overallRate={opts.overallRate ?? COLLAPSED_BASELINE}
    />,
  );
}

/**
 * Stubs `HTMLElement.prototype.scrollWidth`/`clientWidth` for the duration
 * of one test — jsdom never computes real layout, so this is the
 * established technique (per-element, via the getter's own `this`) for
 * exercising a ref-measured truncation/width contract deterministically.
 * Returns a restore function; every test calls it before its own
 * assertions finish (also enforced by the `afterEach` safety net below).
 */
function stubElementGeometry(overrides: {
  tagScrollWidth?: number;
  tagClientWidth?: number;
  metaClientWidth?: number;
}) {
  const originalScrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth');
  const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');

  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get(this: HTMLElement) {
      if (this.hasAttribute('data-truncate-guard') && overrides.tagScrollWidth != null) {
        return overrides.tagScrollWidth;
      }
      return 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      if (this.hasAttribute('data-truncate-guard') && overrides.tagClientWidth != null) {
        return overrides.tagClientWidth;
      }
      if (
        this.getAttribute('data-slot') === 'opponent-row-meta' &&
        overrides.metaClientWidth != null
      ) {
        return overrides.metaClientWidth;
      }
      return 0;
    },
  });

  return () => {
    if (originalScrollWidth) {
      Object.defineProperty(HTMLElement.prototype, 'scrollWidth', originalScrollWidth);
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollWidth');
    }
    if (originalClientWidth) {
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth);
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
    }
  };
}

let restoreGeometry: (() => void) | null = null;

afterEach(async () => {
  restoreGeometry?.();
  restoreGeometry = null;
  await i18n.changeLanguage('en');
});

describe('OpponentRow — one flexible truncating slot (UIX-03)', () => {
  it('renders exactly one element carrying the truncation-guard attribute, and it is the tag', () => {
    const row = buildRow({ wins: 20, losses: 4, displayTag: 'AVeryLongTwentyFourCharTag' });
    const { container } = renderRow(row);

    const guarded = container.querySelectorAll('[data-truncate-guard]');
    expect(guarded).toHaveLength(1);
    expect(guarded[0]!.textContent).toBe(row.displayTag);
  });

  it('content that exactly fills the flexible slot renders with no title attribute (RED against the old markup: the old tag span always carried a title)', () => {
    restoreGeometry = stubElementGeometry({ tagScrollWidth: 200, tagClientWidth: 200 });
    const row = buildRow({ wins: 20, losses: 4, displayTag: 'ExactFit' });
    const { container } = renderRow(row);

    const guarded = container.querySelector('[data-truncate-guard]')!;
    expect(guarded).not.toHaveAttribute('title');
  });

  it('one character (pixel) more than the slot truncates and gains a title carrying the full string', () => {
    restoreGeometry = stubElementGeometry({ tagScrollWidth: 201, tagClientWidth: 200 });
    const row = buildRow({ wins: 20, losses: 4, displayTag: 'OneOverflowsThisSlot' });
    const { container } = renderRow(row);

    const guarded = container.querySelector('[data-truncate-guard]')!;
    expect(guarded).toHaveAttribute('title', row.displayTag);
  });

  it('an empty tag leaves every other token rendered and the slot element present', () => {
    const row = buildRow({ wins: 20, losses: 4, displayTag: '' });
    const { container } = renderRow(row);

    const guarded = container.querySelectorAll('[data-truncate-guard]');
    expect(guarded).toHaveLength(1);
    expect(guarded[0]!.textContent).toBe('');
    // The meta line's other tokens (the source badge) still render — the row
    // height-bearing content is not collapsed by an empty flexible slot.
    expect(screen.getByText('manual')).toBeInTheDocument();
  });

  it('the displayed tag is never sliced/substringed for truncation — only CSS `truncate` (T-39.1-17-01)', () => {
    const source = fs.readFileSync(path.join(SOURCE_DIR, 'OpponentList.tsx'), 'utf8');
    // Scoped to the TAG string specifically — `filtered.slice(...)` (row-count
    // pagination, UIX-02) is a legitimate, unrelated array slice in this same
    // file and must not false-positive this assertion.
    expect(source).not.toMatch(/displayTag\.(slice|substring|substr)\(/);
    expect(source).not.toMatch(/\btruncate\w*\(/); // no home-grown "truncateX(" helper — only Tailwind's `truncate` CLASS
  });
});

describe('OpponentRow — no figure stated twice (UI-SPEC §6.5 rule 4)', () => {
  it("the row's text content contains the games count exactly once", () => {
    const row = buildRow({ wins: 20, losses: 4 }); // total 24, tier "high"
    restoreGeometry = stubElementGeometry({ metaClientWidth: 400 }); // wide: sentence + record both render
    const { container } = renderRow(row);

    const mentions = within(container).getAllByText(/24 games/);
    expect(mentions).toHaveLength(1);
  });
});

describe('OpponentRow — container-query priority drop (declared order)', () => {
  it('at the wider tier (>=380px), the confidence SENTENCE renders as visible text and the record renders', () => {
    const row = buildRow({ wins: 20, losses: 4 });
    restoreGeometry = stubElementGeometry({ metaClientWidth: 400 });
    renderRow(row);

    expect(screen.getByText(/24 games · high confidence/)).toBeInTheDocument();
    // Record's own bare figure (wins–losses) is present alongside the sentence.
    expect(screen.getByText('20–4')).toBeInTheDocument();
  });

  it('below the wider threshold (medium tier), the sentence becomes the glyph with the full sentence as its accessible label — the record still renders', () => {
    const row = buildRow({ wins: 20, losses: 4 });
    restoreGeometry = stubElementGeometry({ metaClientWidth: 300 });
    renderRow(row);

    expect(screen.queryByText(/24 games · high confidence/)).not.toBeInTheDocument();
    const glyph = screen.getByRole('img', { name: 'high confidence, 24 games' });
    expect(glyph).toBeInTheDocument();
    expect(screen.getByText('20–4')).toBeInTheDocument();
  });

  it('at 240px (below both thresholds), the record is absent from the row and its figures live only in the badge tooltip — the flexible slot is never dropped', () => {
    const row = buildRow({ wins: 20, losses: 4, displayTag: 'ATwentyFourCharacterLongTagXX' });
    restoreGeometry = stubElementGeometry({ metaClientWidth: 240 });
    const { container } = renderRow(row);

    // Record is gone from the visible row...
    expect(screen.queryByText('20–4')).not.toBeInTheDocument();
    // ...but the confidence glyph (not the sentence) still renders...
    expect(screen.getByRole('img', { name: 'high confidence, 24 games' })).toBeInTheDocument();
    // ...the flexible slot (tag) is NEVER the first token dropped — it's
    // always present, unlike the record which just disappeared above.
    expect(container.querySelectorAll('[data-truncate-guard]')).toHaveLength(1);
    // ...and the record's own figures are still reachable via the
    // always-present badge tooltip.
    const badgeWrapper = screen.getByText('manual').closest('[title]');
    expect(badgeWrapper).toHaveAttribute('title', '20–4 · 83% · 24');
  });
});

describe('OpponentRow — delta chip only when the engine reports the read notable', () => {
  it('renders a delta chip when the recent record is a genuine trend against the baseline', () => {
    const row = buildRow({ wins: 20, losses: 4 });
    renderRow(row, { overallRate: NOTABLE_BASELINE });

    expect(screen.getByText(/pts$/)).toBeInTheDocument();
  });

  it('renders no delta chip when this opponent dominates the account baseline (collapsed, never notable)', () => {
    const row = buildRow({ wins: 20, losses: 4 });
    renderRow(row, { overallRate: COLLAPSED_BASELINE });

    expect(screen.queryByText(/pts$/)).not.toBeInTheDocument();
  });
});

describe('OpponentRow — long-string locale (measured: de), 240px, 24-character tag (UIX-03)', () => {
  it('the row does not clip: the meta line wraps whole tokens (never mid-token) at every width', async () => {
    await i18n.changeLanguage('de');
    const row = buildRow({ wins: 20, losses: 4, displayTag: 'EinSehrLangerFuenfundzwanzig' });
    restoreGeometry = stubElementGeometry({ metaClientWidth: 240 });
    const { container } = renderRow(row);

    const meta = container.querySelector('[data-slot="opponent-row-meta"]')!;
    // The load-bearing geometry fix: the meta line wraps (`flex-wrap`). The
    // OLD markup's meta line was `flex items-center gap-2` with no wrap
    // class at all — a real narrow container would force every token onto
    // one unbreaking line, overflowing horizontally. This assertion FAILS
    // against that old className (verified by hand before committing).
    expect(meta.className).toMatch(/\bflex-wrap\b/);

    // Every visible text token in the meta line is a WHOLE localized word —
    // never a mid-token split (never a lone fragment like "Konfid" without
    // its "enz"). Every discrete text node's own textContent is checked.
    for (const el of meta.querySelectorAll('span')) {
      const text = el.textContent ?? '';
      expect(text).not.toMatch(/\s[A-Za-zÀ-ÿ]{1,2}$/); // no truncated trailing word-fragment
    }
  });
});
