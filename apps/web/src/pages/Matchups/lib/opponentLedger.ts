import type { ClassifyResult, Match, RateValue } from '@smash-tracker/shared';
import { classify, resolveWindow, toRateValue } from '@smash-tracker/shared';
import { buildFormStripSetKeys } from '@/lib/formStripEvents';

/**
 * Plan 39.1-45 (PD-45-2): a ledger row draws at most its newest 30 sets — the
 * rest are named by the row's "newest N of M sets" caption, never silently
 * dropped.
 */
export const LEDGER_MAX_SETS = 30;

/** One set of one opponent: its games' record, and the instants that order it. */
export interface LedgerSet {
  /** The pairing-wide set key (`buildFormStripSetKeys`): a parsed set id, or a manual play session. */
  key: string;
  /** Set won = its wins exceed its losses (a 1-1 set is not won). */
  won: boolean;
  wins: number;
  losses: number;
  firstGameMs: number;
  lastGameMs: number;
}

/** One rivalry-ledger row (sketch 003 C `renderC`), everything a host needs and nothing it must re-derive. */
export interface OpponentLedgerRow {
  /** The opponent tag exactly as recorded. */
  tag: string;
  /** All-time record against this opponent (`toRateValue`). */
  record: RateValue;
  /** The newest `LEDGER_MAX_SETS` sets, oldest first (by their last game). */
  sets: LedgerSet[];
  /** Totals over EVERY set, not only the drawn ones. */
  setsTotal: number;
  setsWon: number;
  setsLost: number;
  firstMs: number;
  lastMs: number;
  /** PD-45-1: THIS opponent's games inside the D-15 window (last 30 inside 12 months), independent of the page horizon. */
  recent: RateValue;
  /** `classify` of `recent` against `record` (scoped): the chip's ladder state, never re-derived. */
  classification: ClassifyResult;
}

const tagCollator = new Intl.Collator('en', { sensitivity: 'base' });

function compareTags(a: string, b: string): number {
  return tagCollator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The rivalry ledger of a pairing: one row per named opponent (a game with no
 * opponent tag makes no row — `getOpponentRecords`' rule), most games first,
 * tag ascending on ties. Sets come from ONE derivation, plan 42's
 * `buildFormStripSetKeys` over the pairing's matches, so a ledger tick, a
 * form-strip tick and every drill terminus agree — a start.gg / parry.gg set
 * is its parsed set, a run of manual games inside one 3-hour play session is
 * one set. Pure: the input is never mutated and `nowMs` is the host's clock.
 */
export function buildOpponentLedger({
  matches,
  nowMs,
}: {
  matches: Match[];
  nowMs: number;
}): OpponentLedgerRow[] {
  const setKeys = buildFormStripSetKeys(matches);
  const byOpponent = new Map<string, Match[]>();
  for (const match of matches) {
    if (!match.opponent) {
      continue;
    }
    const group = byOpponent.get(match.opponent);
    if (group) {
      group.push(match);
    } else {
      byOpponent.set(match.opponent, [match]);
    }
  }

  const rows: OpponentLedgerRow[] = [];
  for (const [tag, games] of byOpponent) {
    const bySet = new Map<string, Match[]>();
    for (const game of games) {
      const key = setKeys.get(game.id) ?? `game:${game.id}`;
      const group = bySet.get(key);
      if (group) {
        group.push(game);
      } else {
        bySet.set(key, [game]);
      }
    }
    const allSets: LedgerSet[] = [...bySet.entries()].map(([key, setGames]) => {
      const wins = setGames.filter((game) => game.win).length;
      const losses = setGames.length - wins;
      const times = setGames.map((game) => game.time);
      return {
        key,
        won: wins > losses,
        wins,
        losses,
        firstGameMs: Math.min(...times),
        lastGameMs: Math.max(...times),
      };
    });
    allSets.sort((a, b) => a.lastGameMs - b.lastGameMs || compareIds(a.key, b.key));

    const record = toRateValue(games);
    const recent = toRateValue(
      resolveWindow({ matches: games, horizon: 'last30', scoped: true, nowMs }).matches,
    );
    const times = games.map((game) => game.time);
    const setsWon = allSets.filter((set) => set.won).length;
    rows.push({
      tag,
      record,
      sets: allSets.slice(-LEDGER_MAX_SETS),
      setsTotal: allSets.length,
      setsWon,
      setsLost: allSets.length - setsWon,
      firstMs: Math.min(...times),
      lastMs: Math.max(...times),
      recent,
      classification: classify({ recent, baseline: record, scoped: true, hasAction: false }),
    });
  }
  return rows.sort((a, b) => b.record.total - a.record.total || compareTags(a.tag, b.tag));
}
