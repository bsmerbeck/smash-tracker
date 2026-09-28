import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import type { Match } from '@smash-tracker/shared';
import { generateSyntheticMatches } from '@smash-tracker/shared/testUtils';
import i18n from '@/i18n';
import type { FormStripEvent } from '@/components/charts/FormStrip';

/**
 * Plan 39.1-42 Task 1 (owner decision [HUMAN] 2026-09-25, sketch 002-C;
 * PD-42-2 / PD-42-4): the ONE derivation behind every FormStrip host's
 * strip AND its drill terminus — a manual play session (the 3-hour rule the
 * "Session · date" labels already use) is ONE set, start.gg / parry.gg sets
 * keep their parsed ids, groups are named by their tournament, and a run of
 * consecutive manual sessions is one group labelled with its date span.
 *
 * Every case imports the module inside its body, so a missing export fails
 * that case alone (RED-first), never the whole file.
 */

interface FormStripEventsModule {
  buildFormStripSetKeys?: (matches: Match[]) => Map<string, string>;
  createFormStripSetKeyResolver?: (matches: Match[]) => (match: Match) => string[];
  formStripEventLabel?: (match: Match) => string | null;
  formStripSetKeyForMatch?: unknown;
  buildFormStripEvents: (
    matches: Match[],
    recentWindow: { fromMs: number | null; toMs: number | null },
    t: TFunction,
    locale: string,
  ) => FormStripEvent[];
}

async function load(): Promise<FormStripEventsModule> {
  return (await import('@/lib/formStripEvents')) as unknown as FormStripEventsModule;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Midday UTC, so no local zone moves a date across midnight. */
const BASE_MS = Date.UTC(2026, 6, 3, 12);
const NO_WINDOW = { fromMs: null, toMs: null };

function manual(id: string, time: number, win = true, extra: Partial<Match> = {}): Match {
  return {
    id,
    fighter_id: 1,
    opponent_id: 10,
    time,
    win,
    opponent: 'rival',
    notes: '',
    matchType: 'none',
    ...extra,
  } as Match;
}

function startgg(
  id: string,
  setId: string,
  game: number,
  time: number,
  names: { tournamentName?: string; eventName?: string },
  win = true,
): Match {
  return manual(id, time, win, { externalId: `sgg:${setId}:g${game}`, ...names });
}

function ticks(event: FormStripEvent): number {
  return event.sets.reduce((sum, set) => sum + set.games.length, 0);
}

describe('formStripEvents (plan 39.1-42) — one set-key and label derivation', () => {
  it('session-key: a start.gg / parry.gg game keeps its parsed set id', async () => {
    const { buildFormStripSetKeys } = await load();
    const keys = buildFormStripSetKeys!([
      startgg('a1', 'set-abc', 1, BASE_MS, { tournamentName: 'Genesis 9' }),
      manual('p1', BASE_MS + HOUR_MS, true, { externalId: 'pgg-xyz-g2' }),
    ]);
    expect(keys.get('a1')).toBe('set-abc');
    expect(keys.get('p1')).toBe('xyz');
  });

  it('session-key: manual games in one 3-hour session share manual-session:<first game id>; other sessions get their own key', async () => {
    const { buildFormStripSetKeys } = await load();
    const keys = buildFormStripSetKeys!([
      manual('m1', BASE_MS),
      manual('m2', BASE_MS + HOUR_MS),
      manual('m3', BASE_MS + 3.5 * HOUR_MS),
      manual('m4', BASE_MS + 2 * DAY_MS),
      manual('m5', BASE_MS + 2 * DAY_MS + 10 * 60 * 1000),
    ]);
    expect(keys.get('m1')).toBe('manual-session:m1');
    expect(keys.get('m2')).toBe('manual-session:m1');
    // 2.5h after m2 — still inside the 3-hour gap rule of splitIntoSessions.
    expect(keys.get('m3')).toBe('manual-session:m1');
    expect(keys.get('m4')).toBe('manual-session:m4');
    expect(keys.get('m5')).toBe('manual-session:m4');
  });

  it('session-key: deterministic and independent of input order', async () => {
    const { buildFormStripSetKeys } = await load();
    const games = [
      manual('m1', BASE_MS),
      manual('m2', BASE_MS + HOUR_MS),
      startgg('s1', 'set-1', 1, BASE_MS + DAY_MS, { tournamentName: 'Genesis 9' }),
      manual('m3', BASE_MS + 2 * DAY_MS),
    ];
    const forward = buildFormStripSetKeys!(games);
    const reversed = buildFormStripSetKeys!([...games].reverse());
    expect([...reversed.entries()].sort()).toEqual([...forward.entries()].sort());
    expect(buildFormStripSetKeys!(games)).toEqual(forward);
  });

  it('session-key: a keyless game carrying a tournament name never shares a session set with an unnamed game', async () => {
    const { buildFormStripSetKeys } = await load();
    const keys = buildFormStripSetKeys!([
      manual('named', BASE_MS, true, { tournamentName: 'Local Weekly 12' }),
      manual('plain', BASE_MS + HOUR_MS),
    ]);
    expect(keys.get('named')).not.toBe(keys.get('plain'));
  });

  it('legacy-key: the resolver returns [set key, game:<id>] for a manual game and [parsed set id] otherwise', async () => {
    const { createFormStripSetKeyResolver } = await load();
    const m1 = manual('m1', BASE_MS);
    const m2 = manual('m2', BASE_MS + HOUR_MS);
    const s1 = startgg('s1', 'set-1', 1, BASE_MS + DAY_MS, { tournamentName: 'Genesis 9' });
    const resolve = createFormStripSetKeyResolver!([m1, m2, s1]);
    expect(resolve(m2)).toEqual(['manual-session:m1', 'game:m2']);
    expect(resolve(s1)).toEqual(['set-1']);
  });

  it('retired: the per-game set key export (formStripSetKeyForMatch) is gone', async () => {
    const mod = await load();
    expect(mod.formStripSetKeyForMatch).toBeUndefined();
  });

  it('tournament-label: formStripEventLabel prefers the trimmed tournament name, then the event name, else null', async () => {
    const { formStripEventLabel } = await load();
    expect(
      formStripEventLabel!(
        manual('a', BASE_MS, true, {
          tournamentName: '  Genesis 9 ',
          eventName: 'Ultimate Singles',
        }),
      ),
    ).toBe('Genesis 9');
    expect(formStripEventLabel!(manual('b', BASE_MS, true, { eventName: ' Redemption ' }))).toBe(
      'Redemption',
    );
    expect(formStripEventLabel!(manual('c', BASE_MS, true, { tournamentName: '   ' }))).toBeNull();
    expect(formStripEventLabel!(manual('d', BASE_MS))).toBeNull();
  });

  it('tournament-label: a start.gg game at Genesis 9 / Ultimate Singles is grouped and labelled "Genesis 9"', async () => {
    const { buildFormStripEvents } = await load();
    const events = buildFormStripEvents(
      [
        startgg('g1', 'set-1', 1, BASE_MS, {
          tournamentName: 'Genesis 9',
          eventName: 'Ultimate Singles',
        }),
        startgg('g2', 'set-1', 2, BASE_MS + 5 * 60 * 1000, {
          tournamentName: 'Genesis 9',
          eventName: 'Ultimate Singles',
        }),
      ],
      NO_WINDOW,
      i18n.t,
      'en',
    );
    expect(events.map((event) => event.label)).toEqual(['Genesis 9']);
    expect(events[0]!.sets.map((set) => set.key)).toEqual(['set-1']);
  });

  it('recurring-bracket: two tournaments sharing the bracket name "Ultimate Singles" are two groups', async () => {
    const { buildFormStripEvents } = await load();
    const events = buildFormStripEvents(
      [
        startgg('a1', 'set-a', 1, BASE_MS, {
          tournamentName: 'Genesis 9',
          eventName: 'Ultimate Singles',
        }),
        startgg('b1', 'set-b', 1, BASE_MS + 30 * DAY_MS, {
          tournamentName: 'Battle of BC 8',
          eventName: 'Ultimate Singles',
        }),
      ],
      NO_WINDOW,
      i18n.t,
      'en',
    );
    expect(events.map((event) => event.label)).toEqual(['Genesis 9', 'Battle of BC 8']);
  });

  it('event-name-only: a game with only an event name is labelled by it', async () => {
    const { buildFormStripEvents } = await load();
    const events = buildFormStripEvents(
      [startgg('e1', 'set-e', 1, BASE_MS, { eventName: 'Ultimate Singles' })],
      NO_WINDOW,
      i18n.t,
      'en',
    );
    expect(events.map((event) => event.label)).toEqual(['Ultimate Singles']);
  });

  it('session-run-group: consecutive manual sessions form ONE group labelled with the run date span; each session is one set holding its games in order', async () => {
    const { buildFormStripEvents } = await load();
    const run = [
      manual('a1', BASE_MS),
      manual('a2', BASE_MS + 20 * 60 * 1000, false),
      manual('b1', BASE_MS + 5 * DAY_MS),
      manual('b2', BASE_MS + 5 * DAY_MS + 30 * 60 * 1000),
      manual('b3', BASE_MS + 5 * DAY_MS + 60 * 60 * 1000, false),
      manual('c1', BASE_MS + 79 * DAY_MS),
    ];
    const events = buildFormStripEvents([...run].reverse(), NO_WINDOW, i18n.t, 'en');
    expect(events).toHaveLength(1);
    // 3 Jul 2026 -> 20 Sep 2026 (BASE_MS + 79 days).
    expect(events[0]!.label).toMatch(/^Sessions · Jul 3\s*[–-]\s*Sep 20, 2026$/u);
    expect(events[0]!.sets.map((set) => set.key)).toEqual([
      'manual-session:a1',
      'manual-session:b1',
      'manual-session:c1',
    ]);
    expect(events[0]!.sets.map((set) => set.games.map((game) => game.key))).toEqual([
      ['a1', 'a2'],
      ['b1', 'b2', 'b3'],
      ['c1'],
    ]);
  });

  it('session-run-group: a tournament between manual sessions splits the run; a single-session run keeps the "Session · date" label', async () => {
    const { buildFormStripEvents } = await load();
    const events = buildFormStripEvents(
      [
        manual('a1', BASE_MS),
        manual('a2', BASE_MS + 20 * 60 * 1000),
        startgg('t1', 'set-t', 1, BASE_MS + 2 * DAY_MS, { tournamentName: 'Genesis 9' }),
        manual('b1', BASE_MS + 4 * DAY_MS),
        manual('c1', BASE_MS + 6 * DAY_MS),
      ],
      NO_WINDOW,
      i18n.t,
      'en',
    );
    expect(events.map((event) => event.label)).toEqual([
      'Session · Jul 3, 2026',
      'Genesis 9',
      expect.stringMatching(/^Sessions · Jul 7\s*[–-]\s*9, 2026$/u),
    ]);
    expect(events[2]!.sets.map((set) => set.key)).toEqual([
      'manual-session:b1',
      'manual-session:c1',
    ]);
  });

  it('casual-41: the 41-game casual fixture yields one group of session-sets with 41 ticks in total', async () => {
    const { buildFormStripEvents } = await load();
    // guard:layout's `casual` scale / CareerTimelineCard.test.tsx's CASUAL_MATCHES.
    const casual = generateSyntheticMatches({
      seed: 39_135_001,
      count: 41,
      startMs: Date.UTC(2026, 6, 3, 19),
      sessionSizeRange: [2, 6],
      sessionGapMs: 156 * 60 * 60 * 1000,
      winRate: 0.56,
    });
    const events = buildFormStripEvents(casual, NO_WINDOW, i18n.t, 'en');
    expect(events).toHaveLength(1);
    expect(events[0]!.label).toMatch(/^Sessions · /);
    expect(events[0]!.sets.map((set) => set.games.length)).toEqual([2, 6, 2, 4, 5, 3, 4, 6, 5, 4]);
    expect(ticks(events[0]!)).toBe(41);
  });
});
