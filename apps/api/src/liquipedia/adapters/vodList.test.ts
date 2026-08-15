import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { researchEnrichmentObservationRecordSchema } from '@smash-tracker/shared';
import { loadLiquipediaFixture } from '../__fixtures__/loadFixture.js';
import {
  LIQUIPEDIA_VOD_LIST_MIN_BYTES_FOR_GUARD,
  LIQUIPEDIA_VOD_LIST_RESOLUTION_REASON,
  extractVodListRows,
  isVodRowCountPlausible,
  toVodObservationRecords,
  type ExtractVodListRowsResult,
} from './vodList.js';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

interface ParseFixture {
  parse: { title: string; pageid: number; revid: number; text: string };
}
interface ExpandFixture {
  expandtemplates: { wikitext: string };
}

function parsedBody(name: string): { body: string; revisionId: number } {
  const fixture = loadLiquipediaFixture<ParseFixture>(name);
  return { body: fixture.parse.text, revisionId: fixture.parse.revid };
}

function expandedBody(name: string): string {
  const fixture = loadLiquipediaFixture<ExpandFixture>(name);
  return fixture.expandtemplates.wikitext;
}

function extractRendered(name: string, pageTitle: string): ExtractVodListRowsResult {
  const { body, revisionId } = parsedBody(name);
  return extractVodListRows({
    body,
    shape: 'rendered',
    pageTitle,
    revisionId,
    nowMs: 1_700_000_000_000,
    hashHex: sha256Hex,
  });
}

describe('extractVodListRows — Sparg0 fixture (rendered shape)', () => {
  const result = extractRendered('parse-sparg0-vods', 'Sparg0/VODs');

  it('extracts exactly 607 linkable rows across exactly 111 distinct tournament page titles, with a declared count of 608 and an unlinkable count of 1', () => {
    expect(result.extractedCount).toBe(607);
    expect(result.rows).toHaveLength(607);
    expect(new Set(result.rows.map((row) => row.tournamentPageTitle)).size).toBe(111);
    expect(result.declaredCount).toBe(608);
    expect(result.unlinkableCount).toBe(1);
  });

  it('records the declared-but-unlinkable row (opponent "Regi Shikimi") in the reasons log rather than silently dropping it', () => {
    expect(result.reasons.some((reason) => reason.includes('Regi Shikimi'))).toBe(true);
    expect(result.rows.some((row) => row.opponentRawTag === 'Regi Shikimi')).toBe(false);
  });

  it('reports at least 50 duplicate (tournament, opponent) pairs — the mirror-vs-rematch trap this page can never resolve alone', () => {
    expect(result.duplicatePairs.length).toBeGreaterThanOrEqual(50);
    expect(result.duplicatePairs.length).toBe(58);
    for (const pair of result.duplicatePairs) {
      expect(pair.rowIndexes.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('strips the does-not-exist suffix from a redlink opponent title', () => {
    const jesseRow = result.rows.find((row) => row.opponentRawTag === 'Jesse');
    expect(jesseRow?.opponentCanonicalPage).toBe('Jesse (American Player)');
    expect(jesseRow?.opponentCanonicalPage).not.toContain('page does not exist');
  });

  it('decodes an escaped apostrophe in a tournament title to the same string the raw wikitext form would produce', () => {
    const row = result.rows.find((r) => r.tournamentPageTitle === "Let's Make Big Moves/2026");
    expect(row?.tournamentPageTitle).toBe("Let's Make Big Moves/2026");
  });

  it('marks date, round and score as structurally absent — never present as null-valued members, and never inferred', () => {
    const row = result.rows[0]!;
    expect('date' in row).toBe(false);
    expect('round' in row).toBe(false);
    expect('score' in row).toBe(false);
  });

  it('attaches the discovery-index resolution reason to every emitted row', () => {
    expect(
      result.rows.every((row) => row.resolutionReason === LIQUIPEDIA_VOD_LIST_RESOLUTION_REASON),
    ).toBe(true);
  });

  it('carries the game and year section on every row', () => {
    expect(
      result.rows.every((row) => typeof row.game === 'string' && typeof row.year === 'string'),
    ).toBe(true);
    expect(result.rows.some((row) => row.game === 'Ultimate')).toBe(true);
    expect(result.rows.some((row) => row.game === 'Wii U')).toBe(true);
  });

  it('never carries an image or a file reference into an extracted value', () => {
    for (const row of result.rows) {
      expect(row.rawVodUrl).not.toContain('.png');
      expect(row.opponentRawTag ?? '').not.toContain('File:');
      expect(row.tournamentDisplayName ?? '').not.toContain('File:');
    }
    // `commons/images` is asserted absent from every extracted value above; this
    // literal only ever appears here, inside the assertion proving discard.
    expect(result.rows.some((row) => (row.rawVodUrl ?? '').includes('commons/images'))).toBe(false);
  });

  it('computes the content hash over the canonically ordered row list, deterministically across repeated runs', () => {
    const again = extractRendered('parse-sparg0-vods', 'Sparg0/VODs');
    expect(again.contentHash).toBe(result.contentHash);
    expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never rejects a row without also accepting it — accepted plus rejected counts equal the extracted row count', () => {
    const accepted = result.rows.filter((row) => row.vodUrl !== null).length;
    const rejected = result.rows.filter(
      (row) => row.vodUrl === null && row.vodRejectedReason,
    ).length;
    expect(accepted + rejected).toBe(result.extractedCount);
  });

  it('never sets extractionFailed for a real page that yielded real rows', () => {
    expect(result.extractionFailed).toBe(false);
  });
});

describe('extractVodListRows — Sparg0 fixture (expanded shape) agrees with the rendered shape', () => {
  it('yields the identical row count and the identical set of canonical VOD URLs as the rendered fixture', () => {
    const rendered = extractRendered('parse-sparg0-vods', 'Sparg0/VODs');
    const body = expandedBody('expandtemplates-sparg0-vods');
    const expanded = extractVodListRows({
      body,
      shape: 'expanded',
      pageTitle: 'Sparg0/VODs',
      revisionId: rendered.rows[0] ? 347554 : 0,
      nowMs: 1_700_000_000_000,
      hashHex: sha256Hex,
    });

    expect(expanded.extractedCount).toBe(rendered.extractedCount);
    expect(expanded.unlinkableCount).toBe(rendered.unlinkableCount);
    expect(expanded.declaredCount).toBe(rendered.declaredCount);

    const renderedUrls = new Set(rendered.rows.map((row) => row.vodUrl));
    const expandedUrls = new Set(expanded.rows.map((row) => row.vodUrl));
    expect(expandedUrls).toEqual(renderedUrls);
  });
});

describe('extractVodListRows — Hungrybox fixture (scale + host normalization)', () => {
  const result = extractRendered('parse-hungrybox-vods', 'Hungrybox/VODs');

  it('extracts 1477 rows with 35 unlinkable rows and a declared count of 1512 (318 of the 325 tournament cards have at least one LINKABLE row)', () => {
    expect(result.extractedCount).toBe(1477);
    expect(new Set(result.rows.map((row) => row.tournamentPageTitle)).size).toBe(318);
    expect(result.unlinkableCount).toBe(35);
    expect(result.declaredCount).toBe(1512);
  });

  it('normalizes plain-http short links and Twitch links, or rejects them with a stated reason, agreeing with the extracted row count', () => {
    const plainHttpRows = result.rows.filter((row) => row.rawVodUrl.startsWith('http://'));
    expect(plainHttpRows.length).toBeGreaterThan(0);
    for (const row of plainHttpRows) {
      // Every row either normalizes (and is upgraded to https) or is rejected
      // with a stated reason — never neither.
      expect(row.vodUrl !== null || row.vodRejectedReason !== null).toBe(true);
      if (row.vodUrl) {
        expect(row.vodUrl.startsWith('https://')).toBe(true);
      }
    }

    const twitchRows = result.rows.filter((row) => row.vodHost?.includes('twitch'));
    expect(twitchRows.length).toBeGreaterThan(0);

    const accepted = result.rows.filter((row) => row.vodUrl !== null).length;
    const rejected = result.rows.filter((row) => row.vodUrl === null).length;
    expect(accepted + rejected).toBe(result.extractedCount);
  });

  it('reports duplicate (tournament, opponent) pairs at Hungrybox scale', () => {
    expect(result.duplicatePairs.length).toBeGreaterThan(50);
  });
});

describe('extractVodListRows — MKLeo fixture', () => {
  it('extracts 879 rows across 163 tournaments with zero unlinkable rows', () => {
    const result = extractRendered('parse-mkleo-vods', 'MKLeo/VODs');
    expect(result.extractedCount).toBe(879);
    expect(new Set(result.rows.map((row) => row.tournamentPageTitle)).size).toBe(163);
    expect(result.unlinkableCount).toBe(0);
    expect(result.declaredCount).toBe(879);
  });
});

describe('extractVodListRows — the zero-rows regression guard', () => {
  it('sets extractionFailed and returns zero rows for a body at or above the guard threshold with no recognisable rows', () => {
    const body = 'x'.repeat(LIQUIPEDIA_VOD_LIST_MIN_BYTES_FOR_GUARD + 50_000);
    const result = extractVodListRows({
      body,
      shape: 'rendered',
      pageTitle: 'Nobody/VODs',
      revisionId: 1,
      nowMs: 0,
      hashHex: sha256Hex,
    });
    expect(result.extractionFailed).toBe(true);
    expect(result.rows).toHaveLength(0);
    expect(result.reasons.some((reason) => reason.includes('zero-rows guard'))).toBe(true);
  });

  it('does NOT set extractionFailed for a small body under the guard threshold with no rows — a genuinely tiny/empty page is not a failure', () => {
    const result = extractVodListRows({
      body: '{{ResultsPageHeader}}\n{{Player vod list}}',
      shape: 'rendered',
      pageTitle: 'Nobody/VODs',
      revisionId: 1,
      nowMs: 0,
      hashHex: sha256Hex,
    });
    expect(result.extractionFailed).toBe(false);
    expect(result.rows).toHaveLength(0);
  });
});

describe('isVodRowCountPlausible', () => {
  it('accepts a next count within plus-or-minus twenty percent of the previous count', () => {
    expect(isVodRowCountPlausible(100, 120)).toBe(true);
    expect(isVodRowCountPlausible(100, 80)).toBe(true);
    expect(isVodRowCountPlausible(607, 607)).toBe(true);
  });

  it('rejects a next count outside the plus-or-minus twenty percent band', () => {
    expect(isVodRowCountPlausible(100, 121)).toBe(false);
    expect(isVodRowCountPlausible(100, 79)).toBe(false);
  });

  it('treats a zero or negative previous count as always plausible (nothing to compare against on a first run)', () => {
    expect(isVodRowCountPlausible(0, 607)).toBe(true);
    expect(isVodRowCountPlausible(-1, 5)).toBe(true);
  });
});

describe('toVodObservationRecords', () => {
  it('converts rows into observation records that are always matchingStatus "unmatched", carry the vodlist template family and vod-reference content type, and never carry a date/round/score', () => {
    const result = extractRendered('parse-sparg0-vods', 'Sparg0/VODs');
    const records = toVodObservationRecords(result.rows.slice(0, 5), {
      sourcePageTitle: 'Sparg0/VODs',
      sourcePageUrl: 'https://liquipedia.net/smash/Sparg0/VODs',
      sourceRevisionId: 347554,
      sourceContentHash: result.contentHash,
      fetchedAtMs: 1_700_000_000_000,
      observedAtMs: 1_700_000_000_000,
      hashHex: sha256Hex,
      subjectPlayerLabel: 'Sparg0',
    });

    expect(records).toHaveLength(5);
    for (const record of records) {
      expect(record.matchingStatus).toBe('unmatched');
      expect(record.templateFamily).toBe('vodlist');
      expect(record.contentType).toBe('vod-reference');
      expect(record.sourceProvider).toBe('liquipedia');
      expect(record.sourceWiki).toBe('smash');
      expect(record.date).toBeUndefined();
      expect(record.rawDate).toBeUndefined();
      expect(record.scores).toBeUndefined();
      expect(record.rawScores).toBeUndefined();
      expect(record.resolutionReasons).toEqual([LIQUIPEDIA_VOD_LIST_RESOLUTION_REASON]);
    }

    const observationIds = new Set(records.map((record) => record.observationId));
    expect(observationIds.size).toBe(records.length);
  });

  // 30.2 reliability gate: an unusable opponent slot (empty display tag and
  // no canonical page) omits `players` entirely with a stated reason — the
  // previous behavior fabricated an 'unknown' pseudo-player, and an
  // empty-string display tag leaked `rawTag: ""` through `'' ?? fallback`.
  it('omits players (never rawTag "" and never a fabricated tag) for a row whose opponent identity is unusable, keeping the row a valid discovery-index entry', () => {
    const rows = [
      {
        rawVodUrl: 'https://www.youtube.com/watch?v=abc',
        vodUrl: 'https://www.youtube.com/watch?v=abc',
        vodHost: 'youtube.com',
        vodRejectedReason: null,
        opponentRawTag: '',
        opponentCanonicalPage: null,
        opponentCountry: null,
        tournamentPageTitle: 'TestCup/2026',
        tournamentDisplayName: 'Test Cup 2026',
        game: 'Ultimate',
        year: '2026',
        resolutionReason: LIQUIPEDIA_VOD_LIST_RESOLUTION_REASON,
      },
    ];
    const records = toVodObservationRecords(rows, {
      sourcePageTitle: 'Sparg0/VODs',
      sourcePageUrl: 'https://liquipedia.net/smash/Sparg0/VODs',
      sourceRevisionId: 1,
      sourceContentHash: 'a'.repeat(64),
      fetchedAtMs: 1_700_000_000_000,
      observedAtMs: 1_700_000_000_000,
      hashHex: sha256Hex,
      subjectPlayerLabel: 'Sparg0',
    });
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.players).toBeUndefined();
    expect(record.resolutionReasons?.[0]).toBe(LIQUIPEDIA_VOD_LIST_RESOLUTION_REASON);
    expect(record.resolutionReasons?.join(' ')).toContain('players omitted');
    expect(researchEnrichmentObservationRecordSchema.safeParse(record).success).toBe(true);
  });

  it('falls back to the opponent canonical page when the display tag is empty, and trims usable tags', () => {
    const rows = [
      {
        rawVodUrl: 'https://www.youtube.com/watch?v=abc',
        vodUrl: 'https://www.youtube.com/watch?v=abc',
        vodHost: 'youtube.com',
        vodRejectedReason: null,
        opponentRawTag: '  ',
        opponentCanonicalPage: 'Tweek',
        opponentCountry: 'us',
        tournamentPageTitle: 'TestCup/2026',
        tournamentDisplayName: 'Test Cup 2026',
        game: 'Ultimate',
        year: '2026',
        resolutionReason: LIQUIPEDIA_VOD_LIST_RESOLUTION_REASON,
      },
    ];
    const records = toVodObservationRecords(rows, {
      sourcePageTitle: 'Sparg0/VODs',
      sourcePageUrl: 'https://liquipedia.net/smash/Sparg0/VODs',
      sourceRevisionId: 1,
      sourceContentHash: 'a'.repeat(64),
      fetchedAtMs: 1_700_000_000_000,
      observedAtMs: 1_700_000_000_000,
      hashHex: sha256Hex,
      subjectPlayerLabel: ' Sparg0 ',
    });
    expect(records[0]!.players).toEqual([
      { rawTag: 'Sparg0' },
      { rawTag: 'Tweek', canonicalPage: 'Tweek', flag: 'us' },
    ]);
    expect(researchEnrichmentObservationRecordSchema.safeParse(records[0]).success).toBe(true);
  });
});
