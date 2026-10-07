import type { Insight, InsightDoor } from '@smash-tracker/shared';

/**
 * The trackable ref an insight card's scope resolves to (UI-SPEC DD-09), in
 * the exact `kind` + `itemRef` shape `TrackToggle` takes, plus the ids the
 * display name is built from (the localised names live with the caller, never
 * here, so this module stays pure and locale-free).
 */
export type TrackRef =
  | { kind: 'opponent'; itemRef: string; nameParts: { tag: string } }
  | {
      kind: 'matchup';
      itemRef: { fighterId: number; vsFighterId: number };
      nameParts: { fighterId: number; vsFighterId: number };
    }
  | { kind: 'stage'; itemRef: number; nameParts: { stageId: number } };

/** `character:<fighter>:<opponent fighter>` (the Matchups pairing scope) and `matchup:<a>-<b>` (a tracked item's scope). */
const PAIRING_KEY_PATTERNS = [/^character:(\d+):(\d+)$/, /^matchup:(\d+)-(\d+)$/];
const STAGE_KEY_PATTERN = /^stage:(\d+)$/;
const PLAYER_KEY_PREFIX = 'player:';
/** Provider-id identities (`sgg:` / `pgg:`) are not a tag anyone can open a hub for. */
const PROVIDER_IDENTITY_PATTERN = /^(?:sgg|pgg):/;

/** The templates DD-09 lets carry a Track action; every other template id resolves to `null`. */
const TRACKABLE_TEMPLATE_IDS: ReadonlySet<Insight['templateId']> = new Set([
  'characterMovers',
  'rivalMovers',
  'formNow',
  'matchupOrPlayer',
]);

/** The insight's own drill-down axes: what its scope contributed, plus any the template added. Read off the doors, never re-derived from matches. */
function axesOf(insight: Insight): InsightDoor['axes'] {
  const merged: InsightDoor['axes'] = {};
  for (const door of insight.doors) {
    Object.assign(merged, door.axes);
  }
  return merged;
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function matchupRef(fighterId: number | null, vsFighterId: number | null): TrackRef | null {
  if (fighterId === null || vsFighterId === null) {
    return null;
  }
  return {
    kind: 'matchup',
    itemRef: { fighterId, vsFighterId },
    nameParts: { fighterId, vsFighterId },
  };
}

function opponentRef(tag: unknown): TrackRef | null {
  if (typeof tag !== 'string') {
    return null;
  }
  const trimmed = tag.trim();
  if (trimmed.length === 0 || PROVIDER_IDENTITY_PATTERN.test(trimmed)) {
    return null;
  }
  return { kind: 'opponent', itemRef: trimmed, nameParts: { tag: trimmed } };
}

/** A pairing named by the scope key or, failing that, by the fighter + vs axes. */
function pairingFromScope(insight: Insight, axes: InsightDoor['axes']): TrackRef | null {
  for (const pattern of PAIRING_KEY_PATTERNS) {
    const found = pattern.exec(insight.scopeKey);
    if (found) {
      return matchupRef(positiveInt(Number(found[1])), positiveInt(Number(found[2])));
    }
  }
  return matchupRef(positiveInt(axes.fighter), positiveInt(axes.vs));
}

/**
 * DD-09: the trackable ref an insight resolves to, derived from the insight's
 * OWN scope key and door axes, never re-derived from matches.
 *
 * - `characterMovers` -> the matchup (its scope's fighter against the headline
 *   opponent character, both named by the doors' axes).
 * - `rivalMovers` -> the headline rival (the doors' `vs` tag).
 * - `formNow` -> by its scope: `player:<tag>` opponent, `stage:<id>` stage, a
 *   fighter-versus-character pairing matchup. The engine's account-scope
 *   fallback names none of these and resolves to `null`.
 * - `matchupOrPlayer` -> the opponent, and only in its player-driven state; the
 *   matchup-driven state is the pairing page's own read and carries no action.
 *
 * Every other template id (`tiltCost`, `ratingMove`, `sessionFatigue`,
 * `volumeForm`, `mixShift`, `roster*`, `pocketCost`, `secondaryPayoff`,
 * `tierGap`, and the ones DD-09 does not list) is `null`.
 */
export function trackRefForInsight(insight: Insight): TrackRef | null {
  if (!TRACKABLE_TEMPLATE_IDS.has(insight.templateId)) {
    return null;
  }
  const axes = axesOf(insight);
  switch (insight.templateId) {
    case 'characterMovers':
      return matchupRef(positiveInt(axes.fighter), positiveInt(axes.vs));
    case 'rivalMovers':
      return opponentRef(axes.vs);
    case 'matchupOrPlayer':
      return insight.copy.key === 'insights.matchupOrPlayer.player'
        ? opponentRef(insight.copy.values.opponent)
        : null;
    case 'formNow': {
      if (insight.scopeKey.startsWith(PLAYER_KEY_PREFIX)) {
        return opponentRef(insight.scopeKey.slice(PLAYER_KEY_PREFIX.length));
      }
      const stage = STAGE_KEY_PATTERN.exec(insight.scopeKey);
      if (stage) {
        const stageId = positiveInt(Number(stage[1]));
        return stageId === null
          ? null
          : { kind: 'stage', itemRef: stageId, nameParts: { stageId } };
      }
      return pairingFromScope(insight, axes);
    }
    default:
      return null;
  }
}
