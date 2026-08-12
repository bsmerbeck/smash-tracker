import {
  buildEnrichmentObservationId,
  LIQUIPEDIA_PARSER_VERSION_BRACKET_LEGACY,
  type ResearchEnrichmentObservationRecord,
} from '@smash-tracker/shared';
import { buildLiquipediaPageUrl } from '../client.js';
import type { LiquipediaEventContext } from '../eventContext.js';
import { canonicalizeLiquipediaStage, type LiquipediaStageForm } from '../stage.js';
import { normalizeLiquipediaVodUrl } from '../vodUrl.js';
import {
  getGameParam,
  getSetParam,
  hashWikitext,
  splitTopLevelTemplates,
  parseTemplateParameters,
  stripWikiComments,
  type LiquipediaBracketSide,
} from '../wikitext.js';

/**
 * Phase 30.2 Plan 05 (ENR-02, Task 2): the legacy prefixed-parameter bracket
 * adapter — the DOMINANT template family on the smash wiki
 * (`insource:"r3m2p1score"` alone returns 11,427 pages, RESEARCH section 2.6).
 *
 * THE ADVERSARIAL CASE THIS MODULE EXISTS TO GET RIGHT: a grand-final reset
 * (`rNm(M+1)`) shares its parent match's player tags, flags, date and VOD
 * parameters and carries only its OWN scores and its OWN game rows
 * (RESEARCH section 2.6, verbatim, five numbered consequences). A grouper
 * that partitions parameters by the `{side}{round}m{match}` prefix ALONE —
 * without the explicit sibling-inheritance rule implemented below — emits
 * the reset as a set with games and scores but NO players, NO date and NO
 * VOD: a playerless phantom that can never be attributed to a real player
 * and can never be found by a downstream matcher. This module never emits
 * that phantom. When a playerless group has no eligible sibling to inherit
 * from, it is emitted as an EXTRACTION-FAILURE record instead — visible in
 * coverage counters, never silently dropped and never guessed at (T-30.2-22).
 *
 * Grouping is done by ANCHORED full-parameter-name reads
 * (`getSetParam`/`getGameParam` from `wikitext.ts`), never by a prefix scan
 * — a prefix scan of `r1m1` would incorrectly also match `r1m10`..`r1m16`
 * (RESEARCH section 8.10, observed on the SCU pools fixture).
 *
 * `matchingStatus` is set to the initial `'unmatched'` value on every
 * emitted record and NEVER assigned any other value anywhere in this file —
 * extraction never decides a match status; the resolver in a later plan is
 * the only writer of a non-initial status.
 *
 * No I/O, no async, no clock beyond the caller-injected `nowMs` — a pure
 * function over an already-fetched wikitext string.
 */

export interface ExtractLegacyBracketObservationsInput {
  wikitext: string;
  pageTitle: string;
  revisionId: number;
  sha1: string | null;
  eventContext: LiquipediaEventContext;
  targetGame: string;
  nowMs: number;
  hashHex: (value: string) => string;
}

export interface ExtractLegacyBracketObservationsResult {
  observations: ResearchEnrichmentObservationRecord[];
  reasons: string[];
}

/** Matches schema's `games` cap (`researchEnrichmentGameEntrySchema`, `.max(15)`). */
const MAX_GAMES_PER_SET = 15;

/** Matches schema's `resolutionReasons` cap (`.max(10)`). */
const MAX_RESOLUTION_REASONS = 10;

/**
 * Discovers the (side, round, match) key of every SET-level or GAME-level
 * legacy-family parameter, anchored to require the ENTIRE key match one of
 * the documented suffix shapes (RESEARCH section 2.4's inventory) — never a
 * partial/prefix match. `p[12]` restricts the player index to exactly 1 or
 * 2 (RESEARCH: "N ∈ {1,2}"); the two-digit-match-index collision class
 * (`r1m1` vs. `r1m10`) is handled correctly because the round/match digit
 * groups are captured directly rather than string-prefix-matched.
 */
const SET_GROUP_KEY_PATTERN =
  /^([rl])(\d+)m(\d+)(?:p[12](?:score|flag|char\d+|stock\d+)?|win\d*|stage\d+|date|details)$/;

interface BracketTriple {
  side: LiquipediaBracketSide;
  round: number;
  match: number;
}

const MONTH_NAMES: Readonly<Record<string, string>> = {
  january: '01',
  february: '02',
  march: '03',
  april: '04',
  may: '05',
  june: '06',
  july: '07',
  august: '08',
  september: '09',
  october: '10',
  november: '11',
  december: '12',
};

/**
 * Parses a Liquipedia prose date (`August 9, 2026`) into an ISO day
 * (`2026-08-09`) via an explicit month-name table — never `new Date(...)`,
 * which risks timezone-dependent day-shifting on a value RESEARCH section
 * 2.7 documents as day-granularity and event-local, with no time component.
 * Returns `null` on anything that doesn't match the observed shape, rather
 * than guessing.
 */
function parseLiquipediaProseDate(raw: string): string | null {
  const match = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/.exec(raw.trim());
  if (!match) {
    return null;
  }
  const month = MONTH_NAMES[match[1]!.toLowerCase()];
  if (!month) {
    return null;
  }
  const day = match[2]!.padStart(2, '0');
  const year = match[3]!;
  return `${year}-${month}-${day}`;
}

/**
 * Classifies a raw score value into either a numeric score or a stated
 * reason for why it has none — NEVER coerces a non-numeric value (a
 * disqualification marker, the `{{win}}` walkover template call, a `Bye`
 * opponent's empty score, or any other non-numeric text) to zero
 * (RESEARCH section 2.7/6.2).
 */
function parseRawScore(raw: string): { numeric: number | null; reason: string | null } {
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    return { numeric: Number(trimmed), reason: null };
  }
  if (!trimmed) {
    return { numeric: null, reason: 'empty score value; no score recorded' };
  }
  if (trimmed.toUpperCase() === 'DQ') {
    return { numeric: null, reason: 'disqualification marker (DQ); not a numeric score' };
  }
  if (/^\{\{win\}\}$/i.test(trimmed)) {
    return { numeric: null, reason: 'walkover marker ({{win}}); not a numeric score' };
  }
  return {
    numeric: null,
    reason: `non-numeric score value "${trimmed}"; preserved raw, never coerced to zero`,
  };
}

function parseIntOrNull(raw: string | undefined): number | null {
  if (raw === undefined) {
    return null;
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  return Number(trimmed);
}

function parseWinnerSeat(raw: string | undefined): 1 | 2 | undefined {
  if (raw === '1') {
    return 1;
  }
  if (raw === '2') {
    return 2;
  }
  return undefined;
}

/**
 * Extracts the `vod=` parameter from a set's `details={{BracketMatchDetails|...}}`
 * value — the VOD is read from the SET-level `details` parameter ONLY,
 * NEVER from a game row (RESEARCH section 2.5).
 */
function extractVodFromDetails(detailsRaw: string | undefined): string | undefined {
  if (detailsRaw === undefined) {
    return undefined;
  }
  const { templates } = splitTopLevelTemplates(stripWikiComments(detailsRaw));
  const detailsTemplate = templates.find(
    (t) => t.name.trim().toLowerCase() === 'bracketmatchdetails',
  );
  if (!detailsTemplate) {
    return undefined;
  }
  const params = parseTemplateParameters(detailsTemplate.body);
  const vod = params.get('vod');
  return vod && vod.trim() ? vod.trim() : undefined;
}

function tripleKey(side: LiquipediaBracketSide, round: number, match: number): string {
  return `${side}:${round}:${match}`;
}

function discoverTriples(params: Map<string, string>): Map<string, BracketTriple> {
  const triples = new Map<string, BracketTriple>();
  for (const key of params.keys()) {
    const match = SET_GROUP_KEY_PATTERN.exec(key);
    if (!match) {
      continue;
    }
    const side = match[1] as LiquipediaBracketSide;
    const round = Number(match[2]);
    const matchIndex = Number(match[3]);
    triples.set(tripleKey(side, round, matchIndex), { side, round, match: matchIndex });
  }
  return triples;
}

/** Finds the nearest `==Heading==` line preceding `offset` in `source` (post comment-strip, same offsets `splitTopLevelTemplates` used). */
function findSectionHeading(
  source: string,
  offset: number,
  headings: { index: number; text: string }[],
): string | undefined {
  let found: string | undefined;
  for (const heading of headings) {
    if (heading.index < offset) {
      found = heading.text;
    } else {
      break;
    }
  }
  return found;
}

function collectHeadings(source: string): { index: number; text: string }[] {
  const headings: { index: number; text: string }[] = [];
  const pattern = /^==([^=\n]+)==\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    headings.push({ index: match.index, text: match[1]!.trim() });
  }
  return headings;
}

interface GameEntry {
  ordinal: number;
  rawStage?: string;
  stageForm?: LiquipediaStageForm;
  canonicalStageId: number | null;
  rawChars?: [string | null, string | null];
  stocks?: [number | null, number | null];
  winnerSeat?: 1 | 2;
}

function collectGames(
  params: Map<string, string>,
  side: LiquipediaBracketSide,
  round: number,
  match: number,
  eventContext: LiquipediaEventContext,
  targetGame: string,
  resolutionReasons: string[],
): GameEntry[] {
  const games: GameEntry[] = [];
  for (let ordinal = 1; ordinal <= MAX_GAMES_PER_SET; ordinal++) {
    const p1char = getGameParam(params, side, round, match, 'p1char', ordinal);
    const p2char = getGameParam(params, side, round, match, 'p2char', ordinal);
    const p1stockRaw = getGameParam(params, side, round, match, 'p1stock', ordinal);
    const p2stockRaw = getGameParam(params, side, round, match, 'p2stock', ordinal);
    const winRaw = getGameParam(params, side, round, match, 'win', ordinal);
    const stageRaw = getGameParam(params, side, round, match, 'stage', ordinal);

    if (
      p1char === undefined &&
      p2char === undefined &&
      p1stockRaw === undefined &&
      p2stockRaw === undefined &&
      winRaw === undefined &&
      stageRaw === undefined
    ) {
      break;
    }

    const entry: GameEntry = { ordinal, canonicalStageId: null };
    if (stageRaw !== undefined) {
      const canonical = canonicalizeLiquipediaStage(stageRaw, {
        sourceGame: eventContext.game,
        targetGame,
      });
      entry.rawStage = canonical.rawStage;
      entry.stageForm = canonical.stageForm;
      entry.canonicalStageId = canonical.canonicalStageId;
      if (canonical.canonicalStageId === null && canonical.reason) {
        resolutionReasons.push(`game ${ordinal}: ${canonical.reason} ("${stageRaw}")`);
      }
    }
    if (p1char !== undefined || p2char !== undefined) {
      entry.rawChars = [p1char ?? null, p2char ?? null];
    }
    if (p1stockRaw !== undefined || p2stockRaw !== undefined) {
      entry.stocks = [parseIntOrNull(p1stockRaw), parseIntOrNull(p2stockRaw)];
    }
    const winnerSeat = parseWinnerSeat(winRaw);
    if (winnerSeat !== undefined) {
      entry.winnerSeat = winnerSeat;
    }
    games.push(entry);
  }
  return games;
}

interface ResolvedPlayers {
  p1: string;
  p1Flag: string | undefined;
  p2: string;
  p2Flag: string | undefined;
  rawDate: string | undefined;
  detailsRaw: string | undefined;
  inheritedFromKey: string | null;
}

export function extractLegacyBracketObservations(
  input: ExtractLegacyBracketObservationsInput,
): ExtractLegacyBracketObservationsResult {
  const pageReasons: string[] = [];
  const stripped = stripWikiComments(input.wikitext);
  const { templates, truncated } = splitTopLevelTemplates(stripped);
  if (truncated) {
    pageReasons.push(
      'the page wikitext exceeded the bounded template/depth scan limits; extraction may be incomplete',
    );
  }
  const headings = collectHeadings(stripped);
  const sourcePageUrl = buildLiquipediaPageUrl(input.pageTitle);
  const contentHash = hashWikitext(input.wikitext, input.hashHex);

  const observations: ResearchEnrichmentObservationRecord[] = [];

  for (const template of templates) {
    const params = parseTemplateParameters(template.body);
    const hasSetLikeParam = Array.from(params.keys()).some((key) =>
      SET_GROUP_KEY_PATTERN.test(key),
    );
    if (!hasSetLikeParam) {
      continue;
    }

    const triples = discoverTriples(params);
    const sectionHeading = findSectionHeading(stripped, template.start, headings);

    const sorted = Array.from(triples.values()).sort((a, b) =>
      a.side === b.side ? a.round - b.round || a.match - b.match : a.side.localeCompare(b.side),
    );

    for (const triple of sorted) {
      const { side, round, match } = triple;
      const bracketKeyRaw = `${side}${round}m${match}`;
      const bracketKey = `${template.name} ${bracketKeyRaw}`;

      const ownP1 = getSetParam(params, side, round, match, 'p1');
      const ownP2 = getSetParam(params, side, round, match, 'p2');

      let resolved: ResolvedPlayers | null = null;

      if (ownP1 !== undefined && ownP2 !== undefined) {
        resolved = {
          p1: ownP1,
          p1Flag: getSetParam(params, side, round, match, 'p1flag'),
          p2: ownP2,
          p2Flag: getSetParam(params, side, round, match, 'p2flag'),
          rawDate: getSetParam(params, side, round, match, 'date'),
          detailsRaw: getSetParam(params, side, round, match, 'details'),
          inheritedFromKey: null,
        };
      } else {
        // Playerless group: attempt reset inheritance from the sibling with
        // the SAME side and round and the immediately lower match index
        // (this module's header) — never any other match index.
        const siblingMatch = match - 1;
        const siblingP1 =
          siblingMatch >= 1 ? getSetParam(params, side, round, siblingMatch, 'p1') : undefined;
        const siblingP2 =
          siblingMatch >= 1 ? getSetParam(params, side, round, siblingMatch, 'p2') : undefined;

        if (siblingMatch >= 1 && siblingP1 !== undefined && siblingP2 !== undefined) {
          const siblingBracketKey = `${template.name} ${side}${round}m${siblingMatch}`;
          resolved = {
            p1: siblingP1,
            p1Flag: getSetParam(params, side, round, siblingMatch, 'p1flag'),
            p2: siblingP2,
            p2Flag: getSetParam(params, side, round, siblingMatch, 'p2flag'),
            rawDate: getSetParam(params, side, round, siblingMatch, 'date'),
            detailsRaw: getSetParam(params, side, round, siblingMatch, 'details'),
            inheritedFromKey: siblingBracketKey,
          };
        }
      }

      const observationId = buildEnrichmentObservationId(
        {
          sourcePageTitle: input.pageTitle,
          parserVersion: LIQUIPEDIA_PARSER_VERSION_BRACKET_LEGACY,
          discriminator: `${template.name}:${bracketKeyRaw}`,
        },
        input.hashHex,
      );

      if (!resolved) {
        // No eligible sibling to inherit from: emit an extraction-failure
        // record rather than a playerless set (this module's header,
        // T-30.2-22). Never guessed at.
        observations.push({
          observationId,
          sourceProvider: 'liquipedia',
          sourceWiki: 'smash',
          contentType: 'stage-observation',
          sourcePageTitle: input.pageTitle,
          sourcePageUrl,
          sourceRevisionId: input.revisionId,
          sourceContentHash: contentHash,
          parserVersion: LIQUIPEDIA_PARSER_VERSION_BRACKET_LEGACY,
          templateFamily: 'legacy',
          fetchedAtMs: input.nowMs,
          observedAtMs: input.nowMs,
          matchingStatus: 'unmatched',
          sourceSha1: input.sha1,
          bracketTemplate: template.name,
          bracketKey,
          game: input.eventContext.game,
          extractionFailed: true,
          resolutionReasons: [
            `group ${bracketKeyRaw} has score/game parameters but no player tags and no eligible sibling ` +
              `at ${side}${round}m${match - 1} to inherit from; emitted as an extraction failure rather than a playerless set`,
          ],
        });
        continue;
      }

      const resolutionReasons: string[] = [];
      const games = collectGames(
        params,
        side,
        round,
        match,
        input.eventContext,
        input.targetGame,
        resolutionReasons,
      );

      const rawScore1 = getSetParam(params, side, round, match, 'p1score');
      const rawScore2 = getSetParam(params, side, round, match, 'p2score');
      let rawScores: [string, string] | undefined;
      let scores: [number | null, number | null] | undefined;
      if (rawScore1 !== undefined || rawScore2 !== undefined) {
        const s1 = parseRawScore(rawScore1 ?? '');
        const s2 = parseRawScore(rawScore2 ?? '');
        rawScores = [rawScore1 ?? '', rawScore2 ?? ''];
        scores = [s1.numeric, s2.numeric];
        if (rawScore1 !== undefined && s1.reason) {
          resolutionReasons.push(`player 1 score: ${s1.reason}`);
        }
        if (rawScore2 !== undefined && s2.reason) {
          resolutionReasons.push(`player 2 score: ${s2.reason}`);
        }
      }

      const explicitWin = getSetParam(params, side, round, match, 'win');
      let setWinnerSeat: 1 | 2 | undefined;
      let setWinnerDerived: boolean | undefined;

      if (explicitWin === '1' || explicitWin === '2') {
        setWinnerSeat = explicitWin === '1' ? 1 : 2;
        setWinnerDerived = false;
      } else {
        const scoreWinner =
          scores && scores[0] !== null && scores[1] !== null && scores[0] !== scores[1]
            ? scores[0] > scores[1]
              ? 1
              : 2
            : null;
        let wins1 = 0;
        let wins2 = 0;
        for (const game of games) {
          if (game.winnerSeat === 1) {
            wins1++;
          } else if (game.winnerSeat === 2) {
            wins2++;
          }
        }
        const tallyWinner = games.length > 0 && wins1 !== wins2 ? (wins1 > wins2 ? 1 : 2) : null;

        if (scoreWinner !== null && tallyWinner !== null) {
          if (scoreWinner === tallyWinner) {
            setWinnerSeat = scoreWinner as 1 | 2;
            setWinnerDerived = true;
          } else {
            resolutionReasons.push(
              `set winner derivation disagreement: score-derived winner is seat ${scoreWinner}, ` +
                `game-tally-derived winner is seat ${tallyWinner}; no winner asserted`,
            );
          }
        } else if (scoreWinner !== null) {
          setWinnerSeat = scoreWinner as 1 | 2;
          setWinnerDerived = true;
        } else if (tallyWinner !== null) {
          setWinnerSeat = tallyWinner as 1 | 2;
          setWinnerDerived = true;
        }
      }

      const rawVod = extractVodFromDetails(resolved.detailsRaw);
      let rawVodUrl: string | undefined;
      let vodUrl: string | undefined;
      if (rawVod !== undefined) {
        const normalized = normalizeLiquipediaVodUrl(rawVod);
        rawVodUrl = normalized.rawVodUrl;
        if (normalized.vodUrl) {
          vodUrl = normalized.vodUrl;
        } else if (normalized.reason) {
          resolutionReasons.push(`VOD URL rejected: ${normalized.reason}`);
        }
      }

      const rawDate = resolved.rawDate;
      const date = rawDate ? parseLiquipediaProseDate(rawDate) : null;

      const derivedRoundLabel = `${sectionHeading ?? 'Unknown section'} ${side === 'r' ? 'Winners' : 'Losers'} Round ${round} Match ${match}`;

      const observation: ResearchEnrichmentObservationRecord = {
        observationId,
        sourceProvider: 'liquipedia',
        sourceWiki: 'smash',
        contentType: 'stage-observation',
        sourcePageTitle: input.pageTitle,
        sourcePageUrl,
        sourceRevisionId: input.revisionId,
        sourceContentHash: contentHash,
        parserVersion: LIQUIPEDIA_PARSER_VERSION_BRACKET_LEGACY,
        templateFamily: 'legacy',
        fetchedAtMs: input.nowMs,
        observedAtMs: input.nowMs,
        matchingStatus: 'unmatched',
        sourceSha1: input.sha1,
        bracketTemplate: template.name,
        bracketKey,
        game: input.eventContext.game,
        tournamentPageTitle: input.eventContext.tournamentPageTitle,
        tournamentPageUrl: buildLiquipediaPageUrl(input.eventContext.tournamentPageTitle),
        tournamentDisplayName: input.eventContext.tournamentDisplayName,
        tournamentStartggSlug: input.eventContext.startggSlug,
        ...(sectionHeading != null ? { sectionHeading } : {}),
        derivedRoundLabel,
        players: [
          { rawTag: resolved.p1, flag: resolved.p1Flag ?? null },
          { rawTag: resolved.p2, flag: resolved.p2Flag ?? null },
        ],
        games,
      };

      if (rawDate) {
        observation.rawDate = rawDate;
      }
      if (date) {
        observation.date = date;
      }
      if (rawScores) {
        observation.rawScores = rawScores;
      }
      if (scores) {
        observation.scores = scores;
      }
      if (setWinnerSeat !== undefined) {
        observation.setWinnerSeat = setWinnerSeat;
        observation.setWinnerDerived = setWinnerDerived;
      }
      if (resolved.inheritedFromKey) {
        observation.isBracketReset = true;
        observation.vodInheritedFromBracketKey = resolved.inheritedFromKey;
      }
      if (rawVodUrl) {
        observation.rawVodUrl = rawVodUrl;
      }
      if (vodUrl) {
        observation.vodUrl = vodUrl;
      }
      if (resolutionReasons.length > 0) {
        observation.resolutionReasons = resolutionReasons.slice(0, MAX_RESOLUTION_REASONS);
      }

      observations.push(observation);
    }
  }

  return { observations, reasons: pageReasons };
}
