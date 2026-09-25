import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import {
  ACTION_ID_VOCABULARY,
  type ActionCandidate,
  type ActionTarget,
  type ClaimAtom,
  type ClaimId,
} from '@smash-tracker/shared';
import { RecommendedActionsCard } from './RecommendedActionsCard';

/**
 * Phase 39 (plan 39-11, RPT-09 / D-12, 39-UI-SPEC §C): the FREE
 * recommended-actions card. Candidates are hand-built here so each door's
 * destination is asserted against known axes; the producer that feeds the
 * card real engine output is covered in `lib/prepBriefClaims.test.ts`.
 */

const SAMPLE: ClaimAtom['sample'] = {
  rawSampleSize: 12,
  eligibleDenominator: 12,
  knownFieldCoverage: 1,
  dateRange: null,
  refreshedAt: 1_700_000_000_000,
  evidencePolicyVersion: 1,
  recencyTreatment: 'unweighted',
  confidenceTier: 'medium',
};

function makeClaim(id: ClaimId): ClaimAtom {
  return {
    id,
    predicate: 'character_matchup_record',
    subject: { myFighterId: 1, opponentFighterId: 2, stageId: null, opponentTag: null },
    value: { kind: 'record', wins: 3, losses: 9, games: 12 },
    claimKind: 'fact',
    evidenceIds: ['cmr-f1-g2'],
    tier: 'medium',
    policyVersion: 1,
    sample: SAMPLE,
  };
}

const NULL_TARGET: ActionTarget = {
  kind: 'matchup',
  myFighterId: null,
  opponentFighterId: null,
  stageId: null,
  opponentTag: null,
  matchId: null,
};

function makeAction(
  index: number,
  overrides: Omit<Partial<ActionCandidate>, 'target'> & { target?: Partial<ActionTarget> } = {},
): ActionCandidate {
  const { target, ...rest } = overrides;
  return {
    id: ACTION_ID_VOCABULARY[index]!,
    kind: 'matchup_practice',
    claimIds: ['c01'],
    titleKey: 'reports.actions.matchupPractice.title',
    titleParams: { myFighterId: 1, opponentFighterId: 2 },
    doorKey: 'reports.actions.door.practiceMatchup',
    rankScore: 100 - index,
    ...rest,
    target: { ...NULL_TARGET, myFighterId: 1, opponentFighterId: 2, ...target },
  };
}

const PRACTICE = makeAction(0, { target: { kind: 'matchup', stageId: 1 } });
const VOD_ONE = makeAction(1, {
  kind: 'vod_review',
  titleKey: 'reports.actions.vodReview.title',
  titleParams: { opponentTag: 'rival' },
  doorKey: 'reports.actions.door.watchGames',
  target: { kind: 'vod', matchId: 'match-9', opponentTag: 'rival' },
});
const VOD_MANY = makeAction(2, {
  kind: 'vod_review',
  titleKey: 'reports.actions.vodReview.title',
  titleParams: { opponentTag: 'rival' },
  doorKey: 'reports.actions.door.watchGames',
  target: { kind: 'vod', matchId: null, opponentTag: 'rival', myFighterId: null },
});
const DRILL_STAGE = makeAction(3, {
  kind: 'drill',
  titleKey: 'reports.actions.drill.stageHabit',
  titleParams: { stageId: 2, opponentFighterId: 2 },
  doorKey: 'reports.actions.door.openStage',
  target: { kind: 'stage', myFighterId: null, opponentFighterId: null, stageId: 2 },
});
const DRILL_MATCHUP = makeAction(4, {
  kind: 'drill',
  titleKey: 'reports.actions.drill.characterFamiliarity',
  titleParams: { opponentFighterId: 2, opponentTag: 'rival' },
  target: { kind: 'matchup', myFighterId: null, opponentFighterId: 2, opponentTag: 'rival' },
});

const CLAIMS = [makeClaim('c01')];

function renderCard(actions: readonly ActionCandidate[], path = '/tournaments/e1/prep') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <RecommendedActionsCard actions={actions} claims={CLAIMS} />
    </MemoryRouter>,
  );
}

function rows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-action-row]'));
}

function doorHref(row: HTMLElement): string {
  const links = within(row).getAllByRole('link');
  expect(links).toHaveLength(1);
  return links[0]!.getAttribute('href') ?? '';
}

describe('RecommendedActionsCard (free)', () => {
  it('renders three candidates as three rows, each with a kind icon, a title, an evidence caption and exactly one door', () => {
    const { container } = renderCard([PRACTICE, VOD_ONE, DRILL_STAGE]);
    const drawn = rows(container);
    expect(drawn).toHaveLength(3);
    expect(drawn.map((row) => row.dataset.actionKind)).toEqual([
      'matchup_practice',
      'vod_review',
      'drill',
    ]);
    for (const row of drawn) {
      expect(row.querySelector('svg')).not.toBeNull();
      expect(row.querySelector('[data-action-evidence]')?.textContent).toContain('12');
      expect(within(row).getAllByRole('link')).toHaveLength(1);
      expect(row.querySelectorAll('[data-action-door] a')).toHaveLength(1);
    }
    expect(screen.getByText('Practice Mario vs Donkey Kong')).toBeInTheDocument();
    expect(screen.getByText('Review your losses to rival')).toBeInTheDocument();
    expect(screen.getByText('Drill: your game plan on Big Battlefield')).toBeInTheDocument();
  });

  it('never draws a fourth row: four candidates render only the first three, in the order received', () => {
    const { container } = renderCard([PRACTICE, VOD_ONE, DRILL_STAGE, DRILL_MATCHUP]);
    const drawn = rows(container);
    expect(drawn).toHaveLength(3);
    expect(drawn.map((row) => row.dataset.actionKind)).toEqual([
      'matchup_practice',
      'vod_review',
      'drill',
    ]);
    expect(screen.queryByText('Drill: learn the Donkey Kong matchup')).not.toBeInTheDocument();
  });

  it('draws rows in the order it receives them — it never re-ranks', () => {
    const { container } = renderCard([DRILL_STAGE, PRACTICE]);
    expect(rows(container).map((row) => row.dataset.actionKind)).toEqual([
      'drill',
      'matchup_practice',
    ]);
  });

  it('a matchup_practice door goes to the matchups destination with both character axes and the stage axis', () => {
    const { container } = renderCard([PRACTICE]);
    const href = doorHref(rows(container)[0]!);
    const url = new URL(href, 'https://x.test');
    expect(url.pathname).toBe('/matchups');
    expect(url.searchParams.get('fighter')).toBe('1');
    expect(url.searchParams.get('vs')).toBe('2');
    expect(url.searchParams.get('stage')).toBe('1');
  });

  it('a matchup_practice door without a stage axis carries only the character axes', () => {
    const { container } = renderCard([makeAction(0)]);
    const url = new URL(doorHref(rows(container)[0]!), 'https://x.test');
    expect(url.pathname).toBe('/matchups');
    expect(url.searchParams.has('stage')).toBe(false);
  });

  it('a vod_review door goes to the single VOD when one match resolves', () => {
    const { container } = renderCard([VOD_ONE]);
    const url = new URL(doorHref(rows(container)[0]!), 'https://x.test');
    expect(url.pathname).toBe('/vod');
    expect(url.searchParams.get('match')).toBe('match-9');
  });

  it('a vod_review door goes to the filtered game list when several matches resolve', () => {
    const { container } = renderCard([VOD_MANY]);
    const url = new URL(doorHref(rows(container)[0]!), 'https://x.test');
    expect(url.pathname).toBe('/opponents/rival');
    expect(url.searchParams.get('vs')).toBe('2');
  });

  it('a drill door goes to the stage or matchup destination its citing claim maps to', () => {
    const { container } = renderCard([DRILL_STAGE, DRILL_MATCHUP]);
    const [stageRow, matchupRow] = rows(container);
    expect(new URL(doorHref(stageRow!), 'https://x.test').pathname).toBe('/stages/2');
    const matchupUrl = new URL(doorHref(matchupRow!), 'https://x.test');
    expect(matchupUrl.pathname).toBe('/matchups');
    expect(matchupUrl.searchParams.get('vs')).toBe('2');
  });

  it('routes every door through the subject-aware builder: a coach-prefixed render keeps the coach prefix', () => {
    const { container } = renderCard([PRACTICE, VOD_ONE], '/coach/client-7/dashboard');
    const [practiceRow, vodRow] = rows(container);
    expect(doorHref(practiceRow!)).toMatch(/^\/coach\/client-7\/matchups\?/);
    expect(doorHref(vodRow!)).toMatch(/^\/coach\/client-7\/vods\?match=match-9$/);
  });

  it('renders a row WITHOUT a door, never a dead door, when the axes cannot name a destination', () => {
    const doorless = makeAction(0, { target: { ...NULL_TARGET } });
    const { container } = renderCard([doorless]);
    const [row] = rows(container);
    expect(row).toBeDefined();
    expect(within(row!).queryAllByRole('link')).toHaveLength(0);
    expect(row!.querySelector('[data-action-door]')).toBeNull();
    expect(row!.querySelector('button')).toBeNull();
  });

  it('one action renders one row with the same shell as many (no special-cased singular layout)', () => {
    const one = rows(renderCard([PRACTICE]).container);
    const many = rows(renderCard([PRACTICE, VOD_ONE]).container);
    expect(one).toHaveLength(1);
    expect(one[0]!.className).toBe(many[many.length - 1]!.className);
    expect(one[0]!.className).toBe('flex flex-col gap-2 rounded-md border p-3');
  });

  it('zero candidates render the one empty sentence and no row shell, icon, link or list', () => {
    const { container } = renderCard([]);
    expect(
      screen.getByText(
        'Not enough data yet to recommend a specific action — log a few more games.',
      ),
    ).toBeInTheDocument();
    expect(rows(container)).toHaveLength(0);
    expect(container.querySelector('ul')).toBeNull();
    expect(container.querySelector('[data-recommended-actions] svg')).toBeNull();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it('every door the free card draws is an outline button', () => {
    const { container } = renderCard([PRACTICE, VOD_ONE, DRILL_STAGE]);
    const doors = Array.from(container.querySelectorAll('[data-action-door] [data-slot="button"]'));
    expect(doors).toHaveLength(3);
    for (const door of doors) {
      expect(door.getAttribute('data-variant')).toBe('outline');
    }
  });
});

describe('RecommendedActionsCard source (D-11 structural half)', () => {
  const source = readFileSync(resolve(__dirname, 'RecommendedActionsCard.tsx'), 'utf-8')
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join('\n');

  it('carries no paid brand treatment: no default button variant, no brand-tinted text, no Sparkles icon', () => {
    expect(source).not.toMatch(/variant="default"|text-primary|Sparkles/);
  });

  it('spells no route: every destination comes from the door builder and the subject-aware path hook', () => {
    expect(source).not.toMatch(
      /'\/(matchups|vod|stages|tournaments)|`\/(matchups|vod|stages|tournaments)/,
    );
    expect(source).toMatch(/useSubjectPath/);
    expect(source).toMatch(/personalPathForActionTarget/);
  });
});
