import { buildLiquipediaPageUrl } from './client.js';
import {
  decodeWikiEntities,
  parseTemplateParameters,
  splitTopLevelTemplates,
  stripWikiComments,
  stripWikiMarkup,
  type LiquipediaTemplateCall,
} from './wikitext.js';

/**
 * Phase 30.2 Plan 05 (ENR-02, Task 1): reads event identity, the start.gg
 * join key, the date window, the declared game scope, the editor-declared
 * alias remap, and the tournament-level ruleset stage list from a single
 * Liquipedia page's wikitext.
 *
 * A page carries these facts in one of two template shapes, and this module
 * reads BOTH generically rather than assuming which one a given page uses
 * (RESEARCH section 8.5: event metadata lives on the PARENT tournament page
 * via `{{Infobox league|...}}`, while a BRACKET page carries its own
 * `{{TournamentInfo|...}}` block for the game scope, the parent-page link,
 * and the editor-declared alias remap). Both templates happen to share the
 * `game=` key name, so a caller passing either page's wikitext gets a
 * correctly-populated `game` field without this module needing to know in
 * advance which template it will find.
 *
 * `startggSlug` is read under BOTH the modern `startgg=` key and the legacy
 * `smashgg=` key (RESEARCH section 6.1) — the corpus carries both
 * simultaneously (2019-era pages versus 2026-era pages) and always will, so
 * neither key is ever treated as "the" key. Whichever key produced the raw
 * value is recorded in `startggSlugKey` so a caller can distinguish them
 * without re-parsing the source.
 *
 * `rulesetStageRaw` entries are exposed as RAW strings only, deliberately
 * never canonicalized here: a ruleset list states what was LEGAL, not what
 * was PLAYED, and ENR-07's stage facts are game-level observations, not
 * ruleset metadata. `canonicalizeLiquipediaStage` (stage.ts) is never called
 * from this module.
 *
 * No I/O, no async — a pure function over an already-fetched wikitext
 * string.
 */

export type LiquipediaStartggSlugKey = 'startgg' | 'smashgg';

export interface LiquipediaEventContextAliasRemap {
  oldTag: string;
  newTag: string;
}

export interface LiquipediaEventContext {
  /** The page this context was read from, post-redirect/normalization (caller's responsibility to supply). */
  pageTitle: string;
  /** Built with `buildLiquipediaPageUrl`, never reconstructed downstream. */
  pageUrl: string;
  revisionId: number;
  sha1: string | null;
  /** The wiki's declared game scope (e.g. `ultimate`), or `null` when neither template stated one. */
  game: string | null;
  /** The parent tournament page's link when a bracket-page `TournamentInfo.tourneylink` is present, otherwise `pageTitle` itself. */
  tournamentPageTitle: string;
  tournamentDisplayName: string | null;
  /** The normalized start.gg tournament slug (leading `tournament/` and trailing `/details` segments stripped), or `null` when neither key was found. */
  startggSlug: string | null;
  /** Which infobox key supplied `startggSlug` — `null` exactly when `startggSlug` is `null`. */
  startggSlugKey: LiquipediaStartggSlugKey | null;
  /** ISO day (`YYYY-MM-DD`), from `Infobox league`'s `sdate=`. */
  startDateIso: string | null;
  /** ISO day (`YYYY-MM-DD`), from `Infobox league`'s `edate=`. */
  endDateIso: string | null;
  /** The editor-declared historical-tag -> canonical-page-title remap (`TournamentInfo.oldtags`/`newtags`), empty when not declared. */
  aliasRemaps: LiquipediaEventContextAliasRemap[];
  /** The tournament's ruleset stage list, RAW strings only, counterpick suffix stripped — never canonical stage ids. */
  rulesetStageRaw: string[];
  phase: string | null;
  /** Every absent-but-expected value, stated in prose, so a caller never has to reconstruct why a field is `null`. */
  reasons: string[];
}

export interface ExtractEventContextInput {
  wikitext: string;
  pageTitle: string;
  revisionId: number;
  sha1: string | null;
}

/** `s_stageN=` tournament-level ruleset stage lists append a `(CP)` counterpick marker (RESEARCH section 4.4) — ruleset metadata, never part of the stage name. Duplicated locally from `stage.ts`'s private `stripCounterpickSuffix` (that function is not exported — see this module's header for why duplicating a small, well-documented transform is the deliberate choice here rather than widening that module's exports). */
const COUNTERPICK_SUFFIX_PATTERN = /\s*\(cp\)\s*$/i;

/** The highest `s_stageN` ordinal this module will probe for — generous headroom over every ruleset stage list observed in RESEARCH (at most 8 entries), while still bounded rather than an unbounded scan. */
const MAX_RULESET_STAGE_ORDINAL = 30;

function findTemplateByName(
  templates: LiquipediaTemplateCall[],
  name: string,
): LiquipediaTemplateCall | undefined {
  const target = name.toLowerCase();
  return templates.find((template) => template.name.trim().toLowerCase() === target);
}

/**
 * Decodes HTML entities and strips wiki quote-markup from a display string
 * read out of wikitext (`decodeWikiEntities` + `stripWikiMarkup`, both from
 * `wikitext.ts`) so a title carrying an escaped apostrophe or italic markup
 * compares equal to the same title read a different way.
 */
function decodeDisplayString(raw: string): string {
  return stripWikiMarkup(decodeWikiEntities(raw)).trim();
}

/**
 * Normalizes a raw `startgg=`/`smashgg=` value (e.g.
 * `tournament/supernova-2026/details`) by trimming a leading `tournament`
 * path segment and a trailing `details` segment, so both key forms produce
 * the identical normalized slug (`supernova-2026`) regardless of which key
 * supplied the raw value (RESEARCH section 6.1).
 */
export function normalizeStartggSlugValue(raw: string): string {
  const parts = raw
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  let start = 0;
  let end = parts.length;
  if (parts[0]?.toLowerCase() === 'tournament') {
    start = 1;
  }
  if (end > start && parts[end - 1]?.toLowerCase() === 'details') {
    end -= 1;
  }
  return parts.slice(start, end).join('/');
}

/**
 * Reads event identity, its start.gg join key under either parameter name,
 * its date window and its game scope from a single page's wikitext, with
 * full provenance carried on every result (this module's header).
 */
export function extractEventContext(input: ExtractEventContextInput): LiquipediaEventContext {
  const reasons: string[] = [];
  const stripped = stripWikiComments(input.wikitext);
  const { templates } = splitTopLevelTemplates(stripped);

  const tournamentInfoTemplate = findTemplateByName(templates, 'TournamentInfo');
  const infoboxLeagueTemplate = findTemplateByName(templates, 'Infobox league');

  const tournamentInfoParams = tournamentInfoTemplate
    ? parseTemplateParameters(tournamentInfoTemplate.body)
    : null;
  const infoboxParams = infoboxLeagueTemplate
    ? parseTemplateParameters(infoboxLeagueTemplate.body)
    : null;

  const gameRaw = tournamentInfoParams?.get('game')?.trim() || infoboxParams?.get('game')?.trim();
  const game = gameRaw ? gameRaw : null;
  if (!game) {
    reasons.push('no declared game scope (`game=`) found on this page');
  }

  const tourneylinkRaw = tournamentInfoParams?.get('tourneylink')?.trim();
  const tournamentPageTitle = tourneylinkRaw
    ? decodeDisplayString(tourneylinkRaw)
    : input.pageTitle;

  const tourneynameRaw = tournamentInfoParams?.get('tourneyname')?.trim();
  const infoboxNameRaw = infoboxParams?.get('name')?.trim();
  const tournamentDisplayNameRaw = tourneynameRaw || infoboxNameRaw;
  const tournamentDisplayName = tournamentDisplayNameRaw
    ? decodeDisplayString(tournamentDisplayNameRaw)
    : null;

  const phaseRaw = tournamentInfoParams?.get('phase')?.trim();
  const phase = phaseRaw ? phaseRaw : null;

  // Never string-match tournament names (RESEARCH section 6.2, item 1): the
  // page title, this display name, a possible DISPLAYTITLE override and the
  // start.gg slug are four different strings for the same event. The slug
  // below is the only sound join key; date window plus roster is the only
  // sound fallback (see the bracket adapters' entity-resolution notes).
  const startggRaw = infoboxParams?.get('startgg')?.trim();
  const smashggRaw = infoboxParams?.get('smashgg')?.trim();
  let startggSlug: string | null = null;
  let startggSlugKey: LiquipediaStartggSlugKey | null = null;
  if (startggRaw) {
    startggSlug = normalizeStartggSlugValue(startggRaw);
    startggSlugKey = 'startgg';
  } else if (smashggRaw) {
    startggSlug = normalizeStartggSlugValue(smashggRaw);
    startggSlugKey = 'smashgg';
  } else {
    reasons.push(
      'no start.gg slug parameter (`startgg=` or the legacy `smashgg=`) found on this page; ' +
        'this event has no sound provider join key',
    );
  }

  const sdateRaw = infoboxParams?.get('sdate')?.trim();
  const edateRaw = infoboxParams?.get('edate')?.trim();
  const startDateIso = sdateRaw ? sdateRaw : null;
  const endDateIso = edateRaw ? edateRaw : null;
  if (!startDateIso || !endDateIso) {
    reasons.push(
      'tournament start/end date window (`sdate=`/`edate=`) is incomplete or absent on this page',
    );
  }

  const aliasRemaps: LiquipediaEventContextAliasRemap[] = [];
  const oldTagsRaw = tournamentInfoParams?.get('oldtags')?.trim();
  const newTagsRaw = tournamentInfoParams?.get('newtags')?.trim();
  if (oldTagsRaw && newTagsRaw) {
    const oldTags = oldTagsRaw
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);
    const newTags = newTagsRaw
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);
    const pairCount = Math.min(oldTags.length, newTags.length);
    for (let i = 0; i < pairCount; i++) {
      aliasRemaps.push({
        oldTag: decodeDisplayString(oldTags[i]!),
        newTag: decodeDisplayString(newTags[i]!),
      });
    }
  }

  const rulesetStageRaw: string[] = [];
  if (infoboxParams) {
    for (let ordinal = 1; ordinal <= MAX_RULESET_STAGE_ORDINAL; ordinal++) {
      const rawEntry = infoboxParams.get(`s_stage${ordinal}`);
      if (rawEntry === undefined) {
        continue;
      }
      const trimmed = rawEntry.trim();
      if (!trimmed) {
        continue;
      }
      rulesetStageRaw.push(trimmed.replace(COUNTERPICK_SUFFIX_PATTERN, ''));
    }
  }

  return {
    pageTitle: input.pageTitle,
    pageUrl: buildLiquipediaPageUrl(input.pageTitle),
    revisionId: input.revisionId,
    sha1: input.sha1,
    game,
    tournamentPageTitle,
    tournamentDisplayName,
    startggSlug,
    startggSlugKey,
    startDateIso,
    endDateIso,
    aliasRemaps,
    rulesetStageRaw,
    phase,
    reasons,
  };
}
