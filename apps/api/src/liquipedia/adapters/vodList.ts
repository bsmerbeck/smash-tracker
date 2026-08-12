import {
  LIQUIPEDIA_PARSER_VERSION_VOD_LIST,
  buildEnrichmentObservationId,
  type ResearchEnrichmentObservationRecord,
} from '@smash-tracker/shared';
import { decodeWikiEntities, stripWikiMarkup } from '../wikitext.js';
import { normalizeLiquipediaVodUrl } from '../vodUrl.js';

/**
 * Phase 30.2 Plan 06 (ENR-03): the player VOD-LIST-PAGE row extractor —
 * `Sparg0/VODs`, `Hungrybox/VODs`, `MKLeo/VODs` and their kin. This is the
 * ONLY module in this phase that treats a `{{Player vod list}}` generated
 * page as a source, and it treats it for exactly what RESEARCH section 5
 * establishes it is: a DISCOVERY INDEX, never a fact source. No row this
 * module emits ever carries a round, a date or a score — those three fields
 * do not exist as TYPE MEMBERS on `LiquipediaVodRow` at all, deliberately,
 * rather than being present-but-null: the strongest way to make "this page
 * cannot supply them, and nothing downstream may infer them from the year
 * heading or the card order" a structural property instead of a convention
 * a caller could ignore.
 *
 * Supports BOTH generated-output shapes behind one row model:
 * - `'rendered'` — `action=parse` HTML output (`<a href>` anchors, `<img>`
 *   flags, HTML entities).
 * - `'expanded'` — `action=expandtemplates` wikilink output (`[[Page|Tag]]`
 *   links, `[[File:...|link=URL]]` VOD/flag references, no HTML entities).
 *
 * Every regex below is anchored to a small, fixed pattern and applied to a
 * BOUNDED slice of the document (one card body, or one `<br/>`-separated
 * row), never to the whole multi-hundred-kilobyte response with a nested
 * quantifier — the same catastrophic-backtracking discipline `wikitext.ts`
 * documents for bracket-page parsing. The response byte size itself is
 * already capped upstream by `LIQUIPEDIA_MAX_RESPONSE_BYTES`
 * (`client.ts`) before this module ever sees it.
 *
 * No image or file reference is ever carried into an extracted value: this
 * module never reads a `src=`/`srcset=` attribute or a `[[File:...]]`
 * target that isn't the VOD link itself, and the VOD link's OWN file
 * reference (`VOD_Icon.png`) is discarded — only the `link=`/`href=` URL
 * survives. Liquipedia's images are frequently under separate,
 * CC-BY-SA-incompatible licences (RESEARCH section 7); this phase ingests
 * text facts only.
 */

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * The zero-rows regression guard threshold (RESEARCH section 8.6): a
 * response body AT OR ABOVE this size that yields zero extracted rows is an
 * `extractionFailed` result with a stated reason, never an honest "player
 * has no VODs" — Liquipedia can change `{{Player vod list}}`'s output shape
 * at any time with no revision-id change on the `/VODs` page itself, and a
 * silent zero would be indistinguishable from a real empty player.
 */
export const LIQUIPEDIA_VOD_LIST_MIN_BYTES_FOR_GUARD = 102_400;

/**
 * Hard ceiling on the number of game/year-heading + tournament-card markers
 * a single extraction will walk, defense in depth alongside the upstream
 * `LIQUIPEDIA_MAX_RESPONSE_BYTES` cap — generous relative to the largest
 * observed fixture (Hungrybox: 325 cards) so no real page is ever truncated.
 */
const LIQUIPEDIA_VOD_LIST_MAX_MARKERS = 20_000;

/** Every extracted VOD-list row is attached with this stated reason (T-30.2-28, the discovery-index / mirror-vs-rematch protection). */
export const LIQUIPEDIA_VOD_LIST_RESOLUTION_REASON =
  'player VOD-list row: a discovery-index entry that requires bracket corroboration before it may ' +
  'be treated as a fact — this page class carries no round, date or score, so a row can never be ' +
  'auto-attached on its own';

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export type LiquipediaVodListShape = 'rendered' | 'expanded';

export interface LiquipediaVodRow {
  /** Byte-identical to the source's VOD link value, entity-decoded but otherwise unmodified. */
  rawVodUrl: string;
  /** The write-time-normalized, storable URL, or `null` when `normalizeLiquipediaVodUrl` rejected it. */
  vodUrl: string | null;
  vodHost: string | null;
  /** A stated reason `normalizeLiquipediaVodUrl` rejected `rawVodUrl`, or `null` when accepted. */
  vodRejectedReason: string | null;
  /** The event-time display tag, e.g. `"mudd"` — the better MATCH key (RESEARCH section 6.2). */
  opponentRawTag: string | null;
  /** The canonical Liquipedia page title, redlink suffix stripped — the better cross-event IDENTITY key. */
  opponentCanonicalPage: string | null;
  opponentCountry: string | null;
  /** The join key to the bracket page (RESEARCH section 6.1's strongest available signal after the startgg slug). */
  tournamentPageTitle: string;
  tournamentDisplayName: string | null;
  /** The `<h2>` game section, e.g. `"Ultimate"`. */
  game: string | null;
  /** The `<h3>` year section, e.g. `"2026"`. */
  year: string | null;
  resolutionReason: string;
}

export interface LiquipediaVodDuplicatePair {
  tournamentPageTitle: string;
  opponentCanonicalPage: string;
  /** Indexes into the RETURNED `rows` array (post-extraction order), not into any intermediate/raw structure. */
  rowIndexes: number[];
}

export interface ExtractVodListRowsInput {
  body: string;
  shape: LiquipediaVodListShape;
  pageTitle: string;
  revisionId: number;
  nowMs: number;
  hashHex: (value: string) => string;
}

export interface ExtractVodListRowsResult {
  rows: LiquipediaVodRow[];
  /** The page's own self-declared "N VODs on record." total (summed across every game section), or `null` when no such sentence was found at all. */
  declaredCount: number | null;
  extractedCount: number;
  /** Rows carrying an opponent and the ` vs. ` separator but no recognisable VOD link — counted, never silently dropped (RESEARCH section 5.8). */
  unlinkableCount: number;
  duplicatePairs: LiquipediaVodDuplicatePair[];
  /** SHA-256 hex digest over the canonically ordered row list — the freshness key for this page class (the revision id is not usable; see this module's header and RESEARCH section 8.6). */
  contentHash: string;
  extractionFailed: boolean;
  reasons: string[];
}

// ---------------------------------------------------------------------------
// Marker scanning (game heading / year heading / card opener, in document order)
// ---------------------------------------------------------------------------

type MarkerType = 'game' | 'year' | 'card';

interface Marker {
  type: MarkerType;
  index: number;
  end: number;
  text: string | null;
}

/**
 * Matches, in document order: an `<h2>` game heading, an `<h3>` year
 * heading, or the fixed card-opener class-attribute substring that begins
 * every tournament card in BOTH generated shapes (`lp-col lp-d-block
 * lp-col-12`, verified to occur exactly once per tournament card and
 * nowhere else — RESEARCH section 5.5/5.6). Heading tags carry no
 * attributes in the `'expanded'` shape (`<h2>Wii U</h2>`) and an `id=` in
 * the `'rendered'` shape (`<h2 id="Wii_U">Wii U</h2>`); `[^>]*` admits both.
 */
const MARKER_PATTERN = /<h2[^>]*>([^<]*)<\/h2>|<h3[^>]*>([^<]*)<\/h3>|lp-col lp-d-block lp-col-12/g;

function scanMarkers(body: string): Marker[] {
  const markers: Marker[] = [];
  MARKER_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MARKER_PATTERN.exec(body))) {
    const type: MarkerType = match[0].startsWith('<h2')
      ? 'game'
      : match[0].startsWith('<h3')
        ? 'year'
        : 'card';
    markers.push({
      type,
      index: match.index,
      end: MARKER_PATTERN.lastIndex,
      text: match[1] ?? match[2] ?? null,
    });
    if (markers.length >= LIQUIPEDIA_VOD_LIST_MAX_MARKERS) {
      break;
    }
  }
  return markers;
}

// ---------------------------------------------------------------------------
// Declared-count sentence
// ---------------------------------------------------------------------------

/** Matches every "`N` VODs on record." sentence — one per `<h2>` game section, summed for the page total (RESEARCH section 5.5). */
const DECLARED_COUNT_PATTERN = /(\d+) VODs on record\./g;

function extractDeclaredCount(body: string): number | null {
  DECLARED_COUNT_PATTERN.lastIndex = 0;
  let total = 0;
  let found = false;
  let match: RegExpExecArray | null;
  while ((match = DECLARED_COUNT_PATTERN.exec(body))) {
    found = true;
    total += Number(match[1]);
  }
  return found ? total : null;
}

// ---------------------------------------------------------------------------
// Per-shape card / row patterns
// ---------------------------------------------------------------------------

const TOURNAMENT_PATTERN_RENDERED = /<b><a href="[^"]*" title="([^"]*)">([^<]*)<\/a><\/b>/;
const TOURNAMENT_PATTERN_EXPANDED = /<b>\[\[([^|\]]*)\|([^\]]*)\]\]<\/b>/;

const VODLINK_PATTERN_RENDERED = /<span class="plainlinks vodlink"><a href="([^"]*)"/;
const VODLINK_PATTERN_EXPANDED =
  /<span class="plainlinks vodlink">\[\[File:[^|]*\|[^|]*\|link=([^\]]*)\]\]<\/span>/;

/** `class="new"` marks a redlink opponent in the `'rendered'` shape only — the `title` attribute then carries the " (page does not exist)" suffix this pattern lets the caller strip. */
const OPPONENT_PATTERN_RENDERED =
  /<span style="vertical-align:-1px;">&#160;<a href="[^"]*"(?: class="new")? title="([^"]*)">([^<]*)<\/a><\/span>/;
const OPPONENT_PATTERN_EXPANDED =
  /<span style="vertical-align:-1px;">&nbsp;\[\[([^|\]]*)\|([^\]]*)\]\]<\/span>/;

const FLAG_PATTERN_RENDERED = /<span class="flag"><img alt="([^"]*)"/;
const FLAG_PATTERN_EXPANDED =
  /<span class="flag">\[\[File:[^|]*\|[^|]*\|([^|]*)\|link=\]\]<\/span>/;

const REDLINK_SUFFIX_PATTERN = / \(page does not exist\)$/;

function cleanText(value: string): string {
  return stripWikiMarkup(decodeWikiEntities(value)).trim();
}

interface CardResult {
  tournamentPageTitle: string | null;
  tournamentDisplayName: string | null;
}

function extractCardHeader(body: string, shape: LiquipediaVodListShape): CardResult {
  if (shape === 'rendered') {
    const match = TOURNAMENT_PATTERN_RENDERED.exec(body);
    if (!match) {
      return { tournamentPageTitle: null, tournamentDisplayName: null };
    }
    return {
      tournamentPageTitle: cleanText(match[1]!),
      tournamentDisplayName: cleanText(match[2]!),
    };
  }
  const match = TOURNAMENT_PATTERN_EXPANDED.exec(body);
  if (!match) {
    return { tournamentPageTitle: null, tournamentDisplayName: null };
  }
  return {
    // Match2/legacy-adjacent generated wikilinks use underscores for this one
    // field (verified against both the rendered and expanded Sparg0
    // fixtures, which otherwise agree on every tournament page title) — the
    // opponent wikilink target never carries this quirk, so this
    // replacement is scoped to the tournament header only.
    tournamentPageTitle: cleanText(match[1]!.replace(/_/g, ' ')),
    tournamentDisplayName: cleanText(match[2]!),
  };
}

function extractRow(
  chunk: string,
  shape: LiquipediaVodListShape,
): {
  rawVodUrl: string | null;
  opponentRawTag: string | null;
  opponentCanonicalPage: string | null;
  opponentCountry: string | null;
} {
  const vodPattern = shape === 'rendered' ? VODLINK_PATTERN_RENDERED : VODLINK_PATTERN_EXPANDED;
  const vodMatch = vodPattern.exec(chunk);
  const rawVodUrl = vodMatch ? decodeWikiEntities(vodMatch[1]!.trim()) : null;

  const opponentPattern =
    shape === 'rendered' ? OPPONENT_PATTERN_RENDERED : OPPONENT_PATTERN_EXPANDED;
  const opponentMatch = opponentPattern.exec(chunk);
  let opponentCanonicalPage: string | null = null;
  let opponentRawTag: string | null = null;
  if (opponentMatch) {
    const rawPage = cleanText(opponentMatch[1]!);
    opponentCanonicalPage =
      shape === 'rendered' ? rawPage.replace(REDLINK_SUFFIX_PATTERN, '') : rawPage;
    opponentRawTag = cleanText(opponentMatch[2]!);
  }

  const flagPattern = shape === 'rendered' ? FLAG_PATTERN_RENDERED : FLAG_PATTERN_EXPANDED;
  const flagMatch = flagPattern.exec(chunk);
  const opponentCountry = flagMatch ? cleanText(flagMatch[1]!) : null;

  return { rawVodUrl, opponentRawTag, opponentCanonicalPage, opponentCountry };
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export function extractVodListRows(input: ExtractVodListRowsInput): ExtractVodListRowsResult {
  const { body, shape, hashHex } = input;
  const reasons: string[] = [];
  const markers = scanMarkers(body);
  const declaredCount = extractDeclaredCount(body);

  let currentGame: string | null = null;
  let currentYear: string | null = null;
  const rows: LiquipediaVodRow[] = [];
  let unlinkableCount = 0;

  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i]!;
    if (marker.type === 'game') {
      currentGame = marker.text ? cleanText(marker.text) : null;
      continue;
    }
    if (marker.type === 'year') {
      currentYear = marker.text ? cleanText(marker.text) : null;
      continue;
    }

    // Card: the body runs from this marker's end to the START of the next
    // marker (of ANY type), or the end of the document.
    const next = markers[i + 1];
    const cardEnd = next ? next.index : body.length;
    const cardBody = body.slice(marker.end, cardEnd);

    const { tournamentPageTitle, tournamentDisplayName } = extractCardHeader(cardBody, shape);
    if (!tournamentPageTitle) {
      reasons.push(
        `card at document offset ${marker.index} had no recognisable tournament header and was skipped`,
      );
      continue;
    }

    const closeTag = '</b>';
    const closeIndex = cardBody.indexOf(closeTag);
    const rowsBody = closeIndex === -1 ? cardBody : cardBody.slice(closeIndex + closeTag.length);

    for (const chunk of rowsBody.split(/<br\s*\/?>/)) {
      if (!chunk.trim() || !chunk.includes(' vs. ')) {
        continue;
      }
      const extracted = extractRow(chunk, shape);
      if (!extracted.rawVodUrl) {
        unlinkableCount++;
        reasons.push(
          `unlinkable row (declared but no recognisable VOD link): tournament="${tournamentPageTitle}" ` +
            `opponent="${extracted.opponentRawTag ?? 'unknown'}" — opponent recorded, row not carried into rows[]`,
        );
        continue;
      }

      const normalized = normalizeLiquipediaVodUrl(extracted.rawVodUrl);
      rows.push({
        rawVodUrl: extracted.rawVodUrl,
        vodUrl: normalized.vodUrl,
        vodHost: normalized.host,
        vodRejectedReason: normalized.reason,
        opponentRawTag: extracted.opponentRawTag,
        opponentCanonicalPage: extracted.opponentCanonicalPage,
        opponentCountry: extracted.opponentCountry,
        tournamentPageTitle,
        tournamentDisplayName,
        game: currentGame,
        year: currentYear,
        resolutionReason: LIQUIPEDIA_VOD_LIST_RESOLUTION_REASON,
      });
    }
  }

  const duplicatePairs = buildDuplicatePairs(rows);
  const contentHash = hashHex(buildCanonicalHashInput(rows));

  const extractionFailed =
    rows.length === 0 && Buffer.byteLength(body, 'utf8') >= LIQUIPEDIA_VOD_LIST_MIN_BYTES_FOR_GUARD;
  if (extractionFailed) {
    reasons.push(
      `zero-rows guard tripped: body was ${Buffer.byteLength(body, 'utf8')} bytes (>= ` +
        `${LIQUIPEDIA_VOD_LIST_MIN_BYTES_FOR_GUARD}) yet yielded no extracted rows — treated as an ` +
        'extraction failure, never as an honest "player has no VODs"',
    );
  }

  return {
    rows,
    declaredCount,
    extractedCount: rows.length,
    unlinkableCount,
    duplicatePairs,
    contentHash,
    extractionFailed,
    reasons,
  };
}

function buildDuplicatePairs(rows: LiquipediaVodRow[]): LiquipediaVodDuplicatePair[] {
  const groups = new Map<
    string,
    { tournamentPageTitle: string; opponentCanonicalPage: string; rowIndexes: number[] }
  >();
  rows.forEach((row, index) => {
    if (!row.opponentCanonicalPage) {
      return;
    }
    const key = `${row.tournamentPageTitle} ${row.opponentCanonicalPage}`;
    const existing = groups.get(key);
    if (existing) {
      existing.rowIndexes.push(index);
    } else {
      groups.set(key, {
        tournamentPageTitle: row.tournamentPageTitle,
        opponentCanonicalPage: row.opponentCanonicalPage,
        rowIndexes: [index],
      });
    }
  });
  const pairs: LiquipediaVodDuplicatePair[] = [];
  for (const group of groups.values()) {
    if (group.rowIndexes.length > 1) {
      pairs.push(group);
    }
  }
  return pairs;
}

/**
 * Builds the deterministic hash input: the row list sorted by tournament
 * page title, then opponent canonical page, then canonical (or raw, if
 * rejected) VOD URL — never by extraction/document order, so re-running the
 * same page twice (even if Liquipedia reordered cards) produces the SAME
 * content hash whenever the underlying fact set is unchanged.
 */
function buildCanonicalHashInput(rows: LiquipediaVodRow[]): string {
  const sorted = [...rows].sort((a, b) => {
    const byTournament = a.tournamentPageTitle.localeCompare(b.tournamentPageTitle);
    if (byTournament !== 0) return byTournament;
    const byOpponent = (a.opponentCanonicalPage ?? '').localeCompare(b.opponentCanonicalPage ?? '');
    if (byOpponent !== 0) return byOpponent;
    return (a.vodUrl ?? a.rawVodUrl).localeCompare(b.vodUrl ?? b.rawVodUrl);
  });
  return sorted
    .map(
      (row) =>
        `${row.tournamentPageTitle} ${row.opponentCanonicalPage ?? ''} ${row.vodUrl ?? row.rawVodUrl}`,
    )
    .join('\n');
}

// ---------------------------------------------------------------------------
// Plausibility band (T-30.2-27's shrink guard)
// ---------------------------------------------------------------------------

/** The plus-or-minus twenty percent band a run's shrink guard checks a refreshed row count against. `previousCount <= 0` is always plausible (there is nothing to compare a first run against). */
export function isVodRowCountPlausible(previousCount: number, nextCount: number): boolean {
  if (previousCount <= 0) {
    return true;
  }
  const delta = Math.abs(nextCount - previousCount);
  return delta <= previousCount * 0.2;
}

// ---------------------------------------------------------------------------
// Observation record conversion
// ---------------------------------------------------------------------------

export interface ToVodObservationRecordsContext {
  sourcePageTitle: string;
  sourcePageUrl: string;
  sourceRevisionId: number;
  sourceContentHash: string;
  fetchedAtMs: number;
  observedAtMs: number;
  hashHex: (value: string) => string;
  /** The page's own subject player (the label the `/VODs` page was constructed for), used as `players[0]`. */
  subjectPlayerLabel: string;
}

/**
 * Converts extracted rows into `ResearchEnrichmentObservationRecord` values.
 * `matchingStatus` is ALWAYS `'unmatched'` here — this module performs
 * discovery-index extraction only; nothing in this phase's resolver runs
 * inside this function, so no row this function emits may ever claim
 * `'matched'`. `date`/`rawDate`/`scores`/`rawScores`/`setWinnerSeat` are all
 * omitted (never set), mirroring `LiquipediaVodRow`'s own structural
 * absence of those fields.
 */
export function toVodObservationRecords(
  rows: LiquipediaVodRow[],
  context: ToVodObservationRecordsContext,
): ResearchEnrichmentObservationRecord[] {
  return rows.map((row, index) => {
    const discriminator = `${row.tournamentPageTitle}::${row.opponentCanonicalPage ?? ''}::${row.vodUrl ?? row.rawVodUrl}::${index}`;
    const observationId = buildEnrichmentObservationId(
      {
        sourcePageTitle: context.sourcePageTitle,
        parserVersion: LIQUIPEDIA_PARSER_VERSION_VOD_LIST,
        discriminator,
      },
      context.hashHex,
    );

    return {
      observationId,
      sourceProvider: 'liquipedia',
      sourceWiki: 'smash',
      contentType: 'vod-reference',
      sourcePageTitle: context.sourcePageTitle,
      sourcePageUrl: context.sourcePageUrl,
      sourceRevisionId: context.sourceRevisionId,
      sourceContentHash: context.sourceContentHash,
      parserVersion: LIQUIPEDIA_PARSER_VERSION_VOD_LIST,
      templateFamily: 'vodlist',
      fetchedAtMs: context.fetchedAtMs,
      observedAtMs: context.observedAtMs,
      matchingStatus: 'unmatched',
      game: row.game ?? undefined,
      tournamentPageTitle: row.tournamentPageTitle,
      tournamentDisplayName: row.tournamentDisplayName ?? undefined,
      rawVodUrl: row.rawVodUrl,
      vodUrl: row.vodUrl ?? undefined,
      players: [
        { rawTag: context.subjectPlayerLabel },
        {
          rawTag: row.opponentRawTag ?? row.opponentCanonicalPage ?? 'unknown',
          canonicalPage: row.opponentCanonicalPage ?? undefined,
          flag: row.opponentCountry ?? undefined,
        },
      ],
      resolutionReasons: [row.resolutionReason],
    };
  });
}
