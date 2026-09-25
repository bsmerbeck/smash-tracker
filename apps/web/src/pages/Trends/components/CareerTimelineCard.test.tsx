import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { buildCareerTimeline, type Match } from '@smash-tracker/shared';
import { generateSyntheticMatches } from '@smash-tracker/shared/testUtils';
import { CareerTimelineCard } from './CareerTimelineCard';

/**
 * Plan 39.1-34 (UI-SPEC §12.1, sketch 002-C `RatingCard`): the Trends host —
 * real i18n (en), the kit rendered at an explicit `chartWidth` (the D-04 test
 * affordance). Header: title, the grain meta (hidden below xl) and the
 * GlickoExplainer; footer: one element per whole caption key.
 */
const PRO_MATCHES: Match[] = generateSyntheticMatches({
  seed: 39_134_001,
  count: 8_400,
  startMs: Date.UTC(2018, 11, 18, 18),
  sessionSizeRange: [6, 28],
  sessionGapMs: 135 * 60 * 60 * 1000,
  winRate: 0.73,
  mainFighterIds: [8, 22],
  opponentFighterIds: [1, 10],
  stageIds: [1],
});

/** 60 games in one month -> the thin state (session grain, no strips). */
const THIN_MATCHES: Match[] = generateSyntheticMatches({
  seed: 39_134_002,
  count: 60,
  startMs: Date.UTC(2026, 5, 1, 18),
  sessionSizeRange: [4, 8],
  sessionGapMs: 2 * 24 * 60 * 60 * 1000,
  winRate: 0.6,
});

function renderCard(matches: Match[]) {
  return render(<CareerTimelineCard matches={matches} horizon="last30" chartWidth={1000} />);
}

function captionItems(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-slot="career-timeline-caption-item"]')).map(
    (el) => el.textContent ?? '',
  );
}

describe('CareerTimelineCard (plan 39.1-34)', () => {
  const pro = buildCareerTimeline({ matches: PRO_MATCHES, horizon: 'last30', nowMs: Date.now() });

  it('titles the card "Career timeline" and renders the kit chart', () => {
    const { container } = renderCard(PRO_MATCHES);
    expect(screen.getByText('Career timeline')).toBeInTheDocument();
    expect(container.querySelector('[data-slot="career-timeline"]')).not.toBeNull();
  });

  it('puts the grain meta in the header, hidden below xl (1280px)', () => {
    renderCard(PRO_MATCHES);
    const meta = screen.getByText('close of quarter · band = ±RD');
    expect(meta.className).toMatch(/\bhidden\b/);
    expect(meta.className).toMatch(/\bxl:inline\b/);
  });

  it('puts the GlickoExplainer trigger in the header', () => {
    const { container } = renderCard(PRO_MATCHES);
    const header = container.querySelector('[data-slot="card-header"]') as HTMLElement;
    expect(within(header).getByRole('button', { name: 'What is Glicko-2?' })).toBeInTheDocument();
  });

  it('captions the grain, the sessions, the ladder, the strip legend and the model — one element per whole key', () => {
    const { container } = renderCard(PRO_MATCHES);
    expect(captionItems(container)).toEqual([
      `${pro.rating.points.length} quarterly closes`,
      `${pro.rating.sessionCount} rated sessions`,
      `a monthly line would draw ${pro.rating.finerGrainPointCount} points`,
      `rate = win rate vs the ${Math.round(pro.baseline.rate * 100)}% all-time rate — blue above, amber below, no colour under 8 games`,
      'Glicko-2, unofficial.',
    ]);
  });

  it('is plural-correct at count 1 and drops the strip legend on a thin timeline', () => {
    const oneSession = generateSyntheticMatches({
      seed: 39_134_003,
      count: 6,
      startMs: Date.UTC(2026, 5, 1, 18),
      sessionSizeRange: [6, 6],
      winRate: 0.5,
    });
    const { container, unmount } = renderCard(oneSession);
    const items = captionItems(container);
    expect(items).toContain('1 rated session');
    expect(items).toContain('1 per-session close');
    expect(items.some((text) => text.startsWith('rate = win rate'))).toBe(false);
    unmount();
    const thin = renderCard(THIN_MATCHES);
    expect(captionItems(thin.container).some((text) => text.startsWith('rate = win rate'))).toBe(
      false,
    );
    expect(screen.getByText('close of session · band = ±RD')).toBeInTheDocument();
  });
});
