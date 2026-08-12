import {
  buildEnrichmentObservationId,
  LIQUIPEDIA_PARSER_VERSION_BRACKET_MATCH2,
  type ResearchEnrichmentObservationRecord,
} from '@smash-tracker/shared';
import { buildLiquipediaPageUrl } from '../client.js';
import type { LiquipediaEventContext } from '../eventContext.js';
import { canonicalizeLiquipediaStage, type LiquipediaStageForm } from '../stage.js';
import { normalizeLiquipediaVodUrl } from '../vodUrl.js';
import {
  hashWikitext,
  parseTemplateParameters,
  splitTopLevelTemplates,
  stripWikiComments,
} from '../wikitext.js';

/**
 * Phase 30.2 Plan 05 (ENR-02, Task 3): the modern nested (`match2`) bracket
 * adapter — a PILOT family on the smash wiki (five pages in main namespace,
 * RESEARCH section 3.2), structurally different from the legacy family this
 * plan's `legacyBracket.ts` extracts, but emitting the identical
 * `ResearchEnrichmentObservationRecord` shape so a downstream consumer
 * cannot tell the two families apart except by the declared
 * `templateFamily` member.
 *
 * THE RESET ENCODING FOR THIS FAMILY IS UNOBSERVED ON THIS WIKI (RESEARCH
 * section 3.4): none of the five Family B pages inspected during research
 * contains a grand-final reset, and `insource:"bracketreset"` returns ZERO
 * hits wiki-wide. This module therefore NEVER sets a bracket-reset flag and
 * NEVER infers a second set from a single nested match block — there is
 * nothing in the observed corpus to model that inference on, and inventing
 * a shape for a construct nobody has ever seen would be exactly the kind of
 * guess ENR-02/ENR-07 forbid. A `{{Match}}` block this adapter cannot
 * classify (missing/unparseable opponents, no `{{Match}}` template found at
 * all) becomes an EXTRACTION-FAILURE record with a stated reason, which
 * downstream becomes an unmatched coverage entry and an admin-review item —
 * never a guess.
 *
 * `matchingStatus` is set to the same initial `'unmatched'` value the
 * legacy adapter uses, on every emitted record.
 *
 * No I/O, no async, no clock beyond the caller-injected `nowMs` — a pure
 * function over an already-fetched wikitext string.
 */

export interface ExtractMatch2BracketObservationsInput {
  wikitext: string;
  pageTitle: string;
  revisionId: number;
  sha1: string | null;
  eventContext: LiquipediaEventContext;
  targetGame: string;
  nowMs: number;
  hashHex: (value: string) => string;
}

export interface ExtractMatch2BracketObservationsResult {
  observations: ResearchEnrichmentObservationRecord[];
  reasons: string[];
}

/** Matches schema's `games` cap (`researchEnrichmentGameEntrySchema`, `.max(15)`). */
const MAX_GAMES_PER_SET = 15;

/** Matches schema's `resolutionReasons` cap (`.max(10)`). */
const MAX_RESOLUTION_REASONS = 10;

const MATCH_KEY_PATTERN = /^R(\d+)M(\d+)$/i;

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
 * Parses a Liquipedia prose date (`May 18, 2025`) into an ISO day
 * (`2025-05-18`) via an explicit month-name table — mirrors
 * `legacyBracket.ts`'s `parseLiquipediaProseDate` (that function is not
 * exported; this is a deliberate, documented duplication of a small pure
 * transform rather than a cross-adapter dependency).
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

function parseRawScore(raw: string): { numeric: number | null; reason: string | null } {
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    return { numeric: Number(trimmed), reason: null };
  }
  if (!trimmed) {
    return { numeric: null, reason: 'empty score value; no score recorded' };
  }
  return {
    numeric: null,
    reason: `non-numeric score value "${trimmed}"; preserved raw, never coerced to zero`,
  };
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
 * A minimal, local top-level-pipe splitter, deliberately duplicating
 * `wikitext.ts`'s private `splitTopLevelPipes` (that function is not
 * exported — its own doc comment names this adapter as the intended reader
 * of a template's FIRST POSITIONAL argument, e.g. a `{{SoloOpponent|moky|...}}`
 * call's tag or a `{{Chars|fox,1}}` call's character code, neither of which
 * `parseTemplateParameters` retains since both are positional, not
 * `key=value`, segments).
 */
function splitTopLevelPipesLocal(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  let i = 0;
  const len = body.length;
  while (i < len) {
    const two = body.slice(i, i + 2);
    if (two === '{{' || two === '[[') {
      depth++;
      current += two;
      i += 2;
      continue;
    }
    if (two === '}}' || two === ']]') {
      depth = Math.max(0, depth - 1);
      current += two;
      i += 2;
      continue;
    }
    if (body[i] === '|' && depth === 0) {
      parts.push(current);
      current = '';
      i++;
      continue;
    }
    current += body[i];
    i++;
  }
  parts.push(current);
  return parts;
}

function findNestedTemplate(raw: string, name: string) {
  const { templates } = splitTopLevelTemplates(stripWikiComments(raw));
  const target = name.toLowerCase();
  return templates.find((t) => t.name.trim().toLowerCase() === target);
}

/**
 * `splitTopLevelTemplates` (wikitext.ts) slices a template's `body` starting
 * IMMEDIATELY after the name, which means `body` always begins with
 * whatever sits before the first top-level `|` — for a name that breaks on
 * `|` directly (e.g. `{{SoloOpponent|moky|...}}`) that's the pipe itself
 * (an empty pre-segment), and for a name that breaks on a newline first
 * (e.g. `{{Match\n|opponent1=...}}`) that's the newline. Either way, the
 * FIRST element `splitTopLevelPipesLocal` returns is this pre-first-pipe
 * fragment, never a real positional or `key=value` segment —
 * `parseTemplateParameters` already tolerates this silently (that fragment
 * never contains `=`, so it is skipped), but a reader of a POSITIONAL
 * argument (a SoloOpponent tag, a Chars call's `<code>,<stocks>` pair, the
 * Bracket template's `Bracket/<layout>` first argument) must drop it
 * explicitly or it will read this fragment instead of the real value.
 */
function splitTemplateBodySegments(body: string): string[] {
  return splitTopLevelPipesLocal(body).slice(1);
}

interface SoloOpponentResult {
  tag: string;
  flag: string | null;
  scoreRaw: string | null;
}

/**
 * Parses a `{{SoloOpponent|<tag>|flag=<cc>|score=<n>}}` value. Returns
 * `null` when no `SoloOpponent` template can be found, or when its first
 * positional segment is missing or itself looks like a `key=value` pair
 * (i.e. the tag is genuinely absent) — the caller treats a `null` result as
 * part of "this match block cannot be classified".
 */
function parseSoloOpponent(raw: string | undefined): SoloOpponentResult | null {
  if (raw === undefined) {
    return null;
  }
  const solo = findNestedTemplate(raw, 'SoloOpponent');
  if (!solo) {
    return null;
  }
  const segments = splitTemplateBodySegments(solo.body);
  const tagSegment = segments[0];
  if (tagSegment === undefined || tagSegment.includes('=')) {
    return null;
  }
  const tag = tagSegment.trim();
  if (!tag) {
    return null;
  }
  const params = parseTemplateParameters(solo.body);
  const flagRaw = params.get('flag')?.trim();
  const scoreRaw = params.get('score');
  return {
    tag,
    flag: flagRaw ? flagRaw : null,
    scoreRaw: scoreRaw !== undefined ? scoreRaw : null,
  };
}

interface CharsResult {
  char: string | null;
  stock: number | null;
}

/** Parses a `{{Chars|<code>,<stocks>}}` value — stocks live in the SECOND positional field of the Chars call, not a separate parameter (this module's header). */
function parseChars(raw: string | undefined): CharsResult | null {
  if (raw === undefined) {
    return null;
  }
  const chars = findNestedTemplate(raw, 'Chars');
  if (!chars) {
    return null;
  }
  const segments = splitTemplateBodySegments(chars.body);
  const first = segments[0];
  if (first === undefined) {
    return null;
  }
  const commaIndex = first.indexOf(',');
  const charPart = commaIndex === -1 ? first : first.slice(0, commaIndex);
  const stockPart = commaIndex === -1 ? undefined : first.slice(commaIndex + 1);
  const char = charPart.trim() || null;
  const stockTrimmed = stockPart?.trim();
  const stock = stockTrimmed && /^\d+$/.test(stockTrimmed) ? Number(stockTrimmed) : null;
  return { char, stock };
}

interface MapResult {
  o1c: CharsResult | null;
  o2c: CharsResult | null;
  winnerRaw: string | undefined;
  stageRaw: string | undefined;
}

/** Parses a `{{Map|o1c1={{Chars|...}}|o2c1={{Chars|...}}|winner=<1|2>|map=<stage>}}` value. */
function parseMap(raw: string): MapResult | null {
  const mapTemplate = findNestedTemplate(raw, 'Map');
  if (!mapTemplate) {
    return null;
  }
  const params = parseTemplateParameters(mapTemplate.body);
  return {
    o1c: parseChars(params.get('o1c1')),
    o2c: parseChars(params.get('o2c1')),
    winnerRaw: params.get('winner'),
    stageRaw: params.get('map'),
  };
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

function findLayoutName(bracketBody: string): string | null {
  const first = splitTemplateBodySegments(bracketBody)[0];
  if (!first) {
    return null;
  }
  const match = /^\s*(Bracket\/[\w-]+)/.exec(first);
  return match ? match[1]! : null;
}

export function extractMatch2BracketObservations(
  input: ExtractMatch2BracketObservationsInput,
): ExtractMatch2BracketObservationsResult {
  const pageReasons: string[] = [];
  const stripped = stripWikiComments(input.wikitext);
  const { templates, truncated } = splitTopLevelTemplates(stripped);
  if (truncated) {
    pageReasons.push(
      'the page wikitext exceeded the bounded template/depth scan limits; extraction may be incomplete',
    );
  }

  const bracketTemplate = templates.find((t) => t.name.trim().toLowerCase() === 'bracket');
  const observations: ResearchEnrichmentObservationRecord[] = [];

  if (!bracketTemplate) {
    pageReasons.push('no {{Bracket|...}} template found on this page; nothing to extract');
    return { observations, reasons: pageReasons };
  }

  const layoutName = findLayoutName(bracketTemplate.body) ?? 'match2-bracket';
  const bracketParams = parseTemplateParameters(bracketTemplate.body);
  const sourcePageUrl = buildLiquipediaPageUrl(input.pageTitle);
  const contentHash = hashWikitext(input.wikitext, input.hashHex);

  const matchEntries = Array.from(bracketParams.entries())
    .filter(([key]) => MATCH_KEY_PATTERN.test(key))
    .sort(([a], [b]) => a.localeCompare(b));

  for (const [matchKeyRaw, rawMatchValue] of matchEntries) {
    const matchKey = matchKeyRaw.toUpperCase();
    const keyMatch = MATCH_KEY_PATTERN.exec(matchKey)!;
    const roundNum = Number(keyMatch[1]);
    const matchNum = Number(keyMatch[2]);
    const bracketKey = `${layoutName} ${matchKey}`;

    const observationId = buildEnrichmentObservationId(
      {
        sourcePageTitle: input.pageTitle,
        parserVersion: LIQUIPEDIA_PARSER_VERSION_BRACKET_MATCH2,
        discriminator: `${layoutName}:${matchKey}`,
      },
      input.hashHex,
    );

    const matchTemplate = findNestedTemplate(rawMatchValue, 'Match');
    if (!matchTemplate) {
      observations.push({
        observationId,
        sourceProvider: 'liquipedia',
        sourceWiki: 'smash',
        contentType: 'stage-observation',
        sourcePageTitle: input.pageTitle,
        sourcePageUrl,
        sourceRevisionId: input.revisionId,
        sourceContentHash: contentHash,
        parserVersion: LIQUIPEDIA_PARSER_VERSION_BRACKET_MATCH2,
        templateFamily: 'match2',
        fetchedAtMs: input.nowMs,
        observedAtMs: input.nowMs,
        matchingStatus: 'unmatched',
        sourceSha1: input.sha1,
        bracketTemplate: layoutName,
        bracketKey,
        game: input.eventContext.game,
        extractionFailed: true,
        resolutionReasons: [
          `match block ${matchKey}: no {{Match}} template found in this block; unclassified construct`,
        ],
      });
      continue;
    }

    const matchParams = parseTemplateParameters(matchTemplate.body);
    const opponent1 = parseSoloOpponent(matchParams.get('opponent1'));
    const opponent2 = parseSoloOpponent(matchParams.get('opponent2'));

    if (!opponent1 || !opponent2) {
      observations.push({
        observationId,
        sourceProvider: 'liquipedia',
        sourceWiki: 'smash',
        contentType: 'stage-observation',
        sourcePageTitle: input.pageTitle,
        sourcePageUrl,
        sourceRevisionId: input.revisionId,
        sourceContentHash: contentHash,
        parserVersion: LIQUIPEDIA_PARSER_VERSION_BRACKET_MATCH2,
        templateFamily: 'match2',
        fetchedAtMs: input.nowMs,
        observedAtMs: input.nowMs,
        matchingStatus: 'unmatched',
        sourceSha1: input.sha1,
        bracketTemplate: layoutName,
        bracketKey,
        game: input.eventContext.game,
        extractionFailed: true,
        resolutionReasons: [
          `match block ${matchKey}: opponent1/opponent2 could not be parsed as a {{SoloOpponent}} template; unclassified construct`,
        ],
      });
      continue;
    }

    const resolutionReasons: string[] = [];
    const games: GameEntry[] = [];
    for (let ordinal = 1; ordinal <= MAX_GAMES_PER_SET; ordinal++) {
      const mapRaw = matchParams.get(`map${ordinal}`);
      if (mapRaw === undefined) {
        break;
      }
      const parsedMap = parseMap(mapRaw);
      if (!parsedMap) {
        resolutionReasons.push(`game ${ordinal}: could not classify the {{Map}} block; skipped`);
        continue;
      }
      const entry: GameEntry = { ordinal, canonicalStageId: null };
      if (parsedMap.stageRaw !== undefined) {
        const canonical = canonicalizeLiquipediaStage(parsedMap.stageRaw, {
          sourceGame: input.eventContext.game,
          targetGame: input.targetGame,
        });
        entry.rawStage = canonical.rawStage;
        entry.stageForm = canonical.stageForm;
        entry.canonicalStageId = canonical.canonicalStageId;
        if (canonical.canonicalStageId === null && canonical.reason) {
          resolutionReasons.push(`game ${ordinal}: ${canonical.reason} ("${parsedMap.stageRaw}")`);
        }
      }
      if (parsedMap.o1c || parsedMap.o2c) {
        entry.rawChars = [parsedMap.o1c?.char ?? null, parsedMap.o2c?.char ?? null];
      }
      if (parsedMap.o1c || parsedMap.o2c) {
        entry.stocks = [parsedMap.o1c?.stock ?? null, parsedMap.o2c?.stock ?? null];
      }
      const winnerSeat = parseWinnerSeat(parsedMap.winnerRaw);
      if (winnerSeat !== undefined) {
        entry.winnerSeat = winnerSeat;
      }
      games.push(entry);
    }

    let rawScores: [string, string] | undefined;
    let scores: [number | null, number | null] | undefined;
    if (opponent1.scoreRaw !== null || opponent2.scoreRaw !== null) {
      const s1 = parseRawScore(opponent1.scoreRaw ?? '');
      const s2 = parseRawScore(opponent2.scoreRaw ?? '');
      rawScores = [opponent1.scoreRaw ?? '', opponent2.scoreRaw ?? ''];
      scores = [s1.numeric, s2.numeric];
      if (opponent1.scoreRaw !== null && s1.reason) {
        resolutionReasons.push(`opponent 1 score: ${s1.reason}`);
      }
      if (opponent2.scoreRaw !== null && s2.reason) {
        resolutionReasons.push(`opponent 2 score: ${s2.reason}`);
      }
    }

    // This family carries no set-winner parameter on any observed page
    // (this module's header / RESEARCH section 3.2) — the winner is ALWAYS
    // derived from the two scores when they are both numeric.
    let setWinnerSeat: 1 | 2 | undefined;
    let setWinnerDerived: boolean | undefined;
    if (scores && scores[0] !== null && scores[1] !== null && scores[0] !== scores[1]) {
      setWinnerSeat = scores[0] > scores[1] ? 1 : 2;
      setWinnerDerived = true;
    }

    const rawVod = matchParams.get('vod');
    let rawVodUrl: string | undefined;
    let vodUrl: string | undefined;
    if (rawVod && rawVod.trim()) {
      const normalized = normalizeLiquipediaVodUrl(rawVod.trim());
      rawVodUrl = normalized.rawVodUrl;
      if (normalized.vodUrl) {
        vodUrl = normalized.vodUrl;
      } else if (normalized.reason) {
        resolutionReasons.push(`VOD URL rejected: ${normalized.reason}`);
      }
    }

    const rawDate = matchParams.get('date')?.trim();
    const date = rawDate ? parseLiquipediaProseDate(rawDate) : null;

    const derivedRoundLabel = `Round ${roundNum} Match ${matchNum}`;

    const observation: ResearchEnrichmentObservationRecord = {
      observationId,
      sourceProvider: 'liquipedia',
      sourceWiki: 'smash',
      contentType: 'stage-observation',
      sourcePageTitle: input.pageTitle,
      sourcePageUrl,
      sourceRevisionId: input.revisionId,
      sourceContentHash: contentHash,
      parserVersion: LIQUIPEDIA_PARSER_VERSION_BRACKET_MATCH2,
      templateFamily: 'match2',
      fetchedAtMs: input.nowMs,
      observedAtMs: input.nowMs,
      matchingStatus: 'unmatched',
      sourceSha1: input.sha1,
      bracketTemplate: layoutName,
      bracketKey,
      game: input.eventContext.game,
      tournamentPageTitle: input.eventContext.tournamentPageTitle,
      tournamentPageUrl: buildLiquipediaPageUrl(input.eventContext.tournamentPageTitle),
      tournamentDisplayName: input.eventContext.tournamentDisplayName,
      tournamentStartggSlug: input.eventContext.startggSlug,
      derivedRoundLabel,
      players: [
        { rawTag: opponent1.tag, flag: opponent1.flag },
        { rawTag: opponent2.tag, flag: opponent2.flag },
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

  return { observations, reasons: pageReasons };
}
