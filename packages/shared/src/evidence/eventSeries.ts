import type { Match } from '../match.js';
import { resolveOpponentIdentities } from './opponentEvidence.js';
import { isCountableGame, stageBucketId } from './predicate.js';
import { confidenceTierFor, effectiveFloor } from './policy.js';
import { getWinLossRecord } from './records.js';
import { splitIntoSessions } from '../glicko.js';
import type { ClaimKind, ConfidenceTier } from './types.js';

/**
 * OPP-03/D-11: one event-anchored cumulative series, built ONCE and shared
 * by the opponent-scoped and stage-scoped entry points below so they can
 * never diverge on anchoring. A match carrying a non-empty event name
 * anchors to a TOURNAMENT block; everything else anchors to a SESSION via
 * `splitIntoSessions` (`../glicko.js`) — the ONE shared session-splitting
 * implementation, never reimplemented here. Tournament and session anchors
 * live on ONE chronological axis, interleaved by their own first-game
 * timestamp.
 *
 * There is no windowed-average concept anywhere in this module (D-11): the
 * only grouping unit is the anchor itself, never a rolling or trailing
 * window.
 *
 * The tournament-block-splitting rule below is PORTED, not imported, from
 * `apps/web/src/pages/Opponents/tournamentHistory.ts`'s
 * `groupTournamentBlocks`/`TOURNAMENT_PROXIMITY_WINDOW_MS` — `packages/shared`
 * must never import from `apps/web`, so the proximity-window constant is
 * re-declared here with that file named as the source of the rule. Retiring
 * the web copy is deliberately out of scope for this phase (38-01 planner
 * assumption).
 */

/** Ported from `apps/web/src/pages/Opponents/tournamentHistory.ts`'s `TOURNAMENT_PROXIMITY_WINDOW_MS` — kept in sync by naming that file, not by importing it (web must never be imported from `packages/shared`). */
const EVENT_ANCHOR_PROXIMITY_MS = 4 * 24 * 60 * 60 * 1000;

export type EventAnchorKind = 'tournament' | 'session';

/** The full ordered anchor axis one series call returns — an alias, not a wrapper object, so both entry points below can return it directly. */
export type EventSeries = EventAnchor[];

export interface EventAnchor {
  /** Content-derived — kind, normalized name (empty for a session), and the anchor's first-game timestamp. Never an array index; stable across a re-render or a repeat call. */
  key: string;
  kind: EventAnchorKind;
  /** Raw, untruncated display name for a tournament anchor, or a formatted session date for a session anchor. */
  label: string;
  startMs: number;
  endMs: number;
  wins: number;
  losses: number;
  total: number;
  cumulativeWins: number;
  cumulativeLosses: number;
  /** 0-100 domain, matching the chart kit's existing trend convention. */
  cumulativeWinRate: number;
  /** This anchor's OWN countable-game count against `effectiveFloor` — `null` below the floor. The anchor is still emitted either way. */
  confidenceTier: ConfidenceTier | null;
  claimKind: ClaimKind;
  matchIds: string[];
}

interface RawAnchor {
  kind: EventAnchorKind;
  name: string;
  matches: Match[];
}

/**
 * CR-02 (38-REVIEW-FIX): the ONE name-priority rule for a tournament anchor
 * — `eventName` first, `tournamentName` as fallback. Exported so every other
 * module that needs to reproduce (never re-derive by hand) which name a
 * match's tournament anchor uses reads it from here — `apps/web`'s
 * `tournamentHistory.ts` (`tournamentBlockEventKey`) and `TournamentDetailPage.tsx`
 * both used to hard-code their OWN, differently-prioritized expression,
 * which silently diverged from the anchors this module actually builds
 * (`buildOpponentEventSeries`/`buildStageEventSeries`) whenever a match
 * carried both fields with different values — the standard shape for any
 * start.gg-synced set with a named parent tournament.
 */
export function trimmedEventKey(match: Match): string | null {
  const raw = match.eventName ?? match.tournamentName;
  if (raw == null) {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Splits one name-grouped, time-sorted set of tournament matches into blocks whenever consecutive games exceed the proximity window — the same technique `groupTournamentBlocks` uses, ported rather than imported. */
function splitTournamentBlocks(sorted: Match[]): Match[][] {
  const blocks: Match[][] = [];
  let current: Match[] = [];
  for (const match of sorted) {
    const previous = current[current.length - 1];
    if (previous && match.time - previous.time > EVENT_ANCHOR_PROXIMITY_MS) {
      blocks.push(current);
      current = [match];
    } else {
      current.push(match);
    }
  }
  if (current.length > 0) {
    blocks.push(current);
  }
  return blocks;
}

function buildTournamentAnchors(matches: Match[]): RawAnchor[] {
  const byName = new Map<string, Match[]>();
  for (const match of matches) {
    const name = trimmedEventKey(match);
    if (name === null) {
      continue;
    }
    const group = byName.get(name);
    if (group) {
      group.push(match);
    } else {
      byName.set(name, [match]);
    }
  }

  const anchors: RawAnchor[] = [];
  for (const [name, group] of byName) {
    const sorted = [...group].sort((a, b) => a.time - b.time);
    for (const block of splitTournamentBlocks(sorted)) {
      anchors.push({ kind: 'tournament', name, matches: block });
    }
  }
  return anchors;
}

function buildSessionAnchors(matches: Match[]): RawAnchor[] {
  const nonTournament = matches.filter((m) => trimmedEventKey(m) === null);
  return splitIntoSessions(nonTournament).map((session) => ({
    kind: 'session' as const,
    name: '',
    matches: session,
  }));
}

/**
 * CR-02/CR-03 (38-REVIEW-FIX): the ONE anchor-key FORMAT, exported alongside
 * `trimmedEventKey` for the identical reason — any module that needs to
 * compute (never hand-format) the key one of this module's own anchors will
 * carry must call this, not re-implement the template string.
 */
export function anchorKey(kind: EventAnchorKind, name: string, startMs: number): string {
  return `${kind}:${name.trim().toLowerCase()}:${startMs}`;
}

function formatSessionLabel(startMs: number): string {
  return new Date(startMs).toISOString();
}

/**
 * The one internal builder both public entry points delegate to. `matches`
 * must already be identity/stage-scoped AND countability-filtered by the
 * caller — this function does no further scoping of its own.
 */
function buildEventSeries(
  countableMatches: Match[],
  refreshedAt: number,
  minMatches?: number,
): EventSeries {
  void refreshedAt; // reserved for parity with the other builders' input shape; anchors carry no whole-series SampleMeta today.
  const floor = effectiveFloor(minMatches);
  const raw = [
    ...buildTournamentAnchors(countableMatches),
    ...buildSessionAnchors(countableMatches),
  ];

  const withTimes = raw.map((anchor) => {
    const times = anchor.matches.map((m) => m.time);
    const startMs = Math.min(...times);
    const endMs = Math.max(...times);
    return { ...anchor, startMs, endMs };
  });

  withTimes.sort((a, b) => {
    if (a.startMs !== b.startMs) return a.startMs - b.startMs;
    const keyA = anchorKey(a.kind, a.name, a.startMs);
    const keyB = anchorKey(b.kind, b.name, b.startMs);
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  });

  let cumulativeWins = 0;
  let cumulativeLosses = 0;
  const anchors: EventAnchor[] = [];
  for (const anchor of withTimes) {
    const record = getWinLossRecord(anchor.matches);
    cumulativeWins += record.wins;
    cumulativeLosses += record.losses;
    const cumulativeTotal = cumulativeWins + cumulativeLosses;
    const cumulativeWinRate =
      cumulativeLosses > 0 ? Math.round((cumulativeWins / cumulativeTotal) * 100) : 100;
    const confidenceTier: ConfidenceTier | null =
      record.total < floor ? null : confidenceTierFor(record.total);
    anchors.push({
      key: anchorKey(anchor.kind, anchor.name, anchor.startMs),
      kind: anchor.kind,
      label: anchor.kind === 'tournament' ? anchor.name : formatSessionLabel(anchor.startMs),
      startMs: anchor.startMs,
      endMs: anchor.endMs,
      wins: record.wins,
      losses: record.losses,
      total: record.total,
      cumulativeWins,
      cumulativeLosses,
      cumulativeWinRate,
      confidenceTier,
      claimKind: 'fact',
      matchIds: anchor.matches.map((m) => m.id),
    });
  }
  return anchors;
}

/** One opponent's event-anchored series, resolved through the same one identity hop `opponentCrossTab.ts` uses. */
export function buildOpponentEventSeries(input: {
  matches: Match[];
  aliasMap: Record<string, string>;
  opponentTag: string;
  refreshedAt: number;
  minMatches?: number;
}): EventSeries {
  const { matches, aliasMap, opponentTag, refreshedAt, minMatches } = input;
  const resolve = resolveOpponentIdentities(matches, aliasMap);
  const targetIdentity = resolve({ opponent: opponentTag });
  const versus = matches.filter((m) => resolve(m) === targetIdentity);
  const countable = versus.filter(isCountableGame);
  return buildEventSeries(countable, refreshedAt, minMatches);
}

/** One stage's event-anchored series, scoped by `stageBucketId` — never alias-map dependent. */
export function buildStageEventSeries(input: {
  matches: Match[];
  stageId: number;
  refreshedAt: number;
  minMatches?: number;
}): EventSeries {
  const { matches, stageId, refreshedAt, minMatches } = input;
  const onStage = matches.filter((m) => stageBucketId(m) === stageId);
  const countable = onStage.filter(isCountableGame);
  return buildEventSeries(countable, refreshedAt, minMatches);
}
