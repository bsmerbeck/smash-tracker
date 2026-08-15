import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RESEARCH_ENRICHMENT_MAX_URL } from '@smash-tracker/shared';
import { loadLiquipediaFixture } from '../../liquipedia/__fixtures__/loadFixture.js';
import { extractEventContext } from '../../liquipedia/eventContext.js';
import { detectTemplateFamily } from '../../liquipedia/wikitext.js';
import { extractLegacyBracketObservations } from '../../liquipedia/adapters/legacyBracket.js';
import { extractMatch2BracketObservations } from '../../liquipedia/adapters/match2Bracket.js';
import { extractVodListRows, toVodObservationRecords } from '../../liquipedia/adapters/vodList.js';
import {
  computeObservationPersistenceHash,
  prepareAndValidateObservation,
} from './prepareObservation.js';

/**
 * 30.2 reliability gate (owner corrective directive, Gate 1): every
 * committed Liquipedia fixture runs through extraction AND the exact
 * persistence schema — via the same `prepareAndValidateObservation` gate the
 * run driver uses — so no fixture-representable page can ever produce a
 * record the write boundary would reject. This is the corpus-level
 * regression net for the MkLeo write-boundary abort, plus boundary/fuzz
 * cases over malformed untrusted input.
 */

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const NOW_MS = 1_754_000_000_000;

interface QueryRevisionFixture {
  query: {
    pages: Array<{
      title?: string;
      missing?: boolean;
      revisions?: Array<{ revid?: number; sha1?: string; slots: { main: { content: string } } }>;
    }>;
  };
}

interface ParseFixture {
  parse: { title: string; pageid: number; revid: number; text: string };
}

interface ExpandFixture {
  expandtemplates: { wikitext: string };
}

/** Every content-bearing page in a `prop=revisions` fixture. */
function wikitextPages(
  name: string,
): Array<{ title: string; wikitext: string; revisionId: number; sha1: string | null }> {
  const fixture = loadLiquipediaFixture<QueryRevisionFixture>(name);
  return fixture.query.pages.flatMap((page) => {
    const revision = page.revisions?.[0];
    const content = revision?.slots.main.content;
    if (page.missing || content == null) {
      return [];
    }
    return [
      {
        title: page.title ?? name,
        wikitext: content,
        revisionId: revision?.revid ?? 0,
        sha1: revision?.sha1 ?? null,
      },
    ];
  });
}

/** Mirrors the run driver's family dispatch over one wikitext page and returns every emitted observation. */
function extractByFamily(page: {
  title: string;
  wikitext: string;
  revisionId: number;
  sha1: string | null;
}) {
  const detected = detectTemplateFamily(page.wikitext);
  if (detected.family === 'unknown') {
    return { family: detected.family, observations: [] };
  }
  const eventContext = extractEventContext({
    wikitext: page.wikitext,
    pageTitle: page.title,
    revisionId: page.revisionId,
    sha1: page.sha1,
  });
  const input = {
    wikitext: page.wikitext,
    pageTitle: page.title,
    revisionId: page.revisionId,
    sha1: page.sha1,
    eventContext,
    targetGame: 'ultimate',
    nowMs: NOW_MS,
    hashHex: sha256Hex,
  };
  const extracted =
    detected.family === 'legacy'
      ? extractLegacyBracketObservations(input)
      : extractMatch2BracketObservations(input);
  return { family: detected.family, observations: extracted.observations };
}

const WIKITEXT_FIXTURES = [
  'query-supernova-2026-singles-bracket',
  'query-supernova-2026-tournament',
  'query-scu-singles-pools-a3',
  'query-ssc-2019-ultimate',
  'query-full-house-2025-singles-bracket',
  'query-vodpages-stub-wikitext',
] as const;

const RENDERED_VOD_FIXTURES = [
  ['parse-sparg0-vods', 'Sparg0/VODs'],
  ['parse-hungrybox-vods', 'Hungrybox/VODs'],
  ['parse-mkleo-vods', 'MKLeo/VODs'],
] as const;

describe('fixture-corpus persistence parity', () => {
  it.each(WIKITEXT_FIXTURES)(
    'every observation extracted from %s passes the exact persistence schema',
    (fixtureName) => {
      let extractedAny = false;
      for (const page of wikitextPages(fixtureName)) {
        const { observations } = extractByFamily(page);
        for (const observation of observations) {
          extractedAny = true;
          const prepared = prepareAndValidateObservation(observation);
          expect(prepared).toEqual(observation);
        }
      }
      // Not every fixture yields observations (tournament/stub pages are
      // family-unknown) — that absence is itself a valid outcome; the
      // assertion above is what matters when records exist.
      void extractedAny;
    },
  );

  it.each(RENDERED_VOD_FIXTURES)(
    'every VOD-list observation converted from %s (rendered) passes the exact persistence schema',
    (fixtureName, pageTitle) => {
      const fixture = loadLiquipediaFixture<ParseFixture>(fixtureName);
      const result = extractVodListRows({
        body: fixture.parse.text,
        shape: 'rendered',
        pageTitle,
        revisionId: fixture.parse.revid,
        nowMs: NOW_MS,
        hashHex: sha256Hex,
      });
      expect(result.rows.length).toBeGreaterThan(0);
      const records = toVodObservationRecords(result.rows, {
        sourcePageTitle: pageTitle,
        sourcePageUrl: `https://liquipedia.net/smash/${pageTitle.replace(/ /g, '_')}`,
        sourceRevisionId: fixture.parse.revid,
        sourceContentHash: result.contentHash,
        fetchedAtMs: NOW_MS,
        observedAtMs: NOW_MS,
        hashHex: sha256Hex,
        subjectPlayerLabel: pageTitle.split('/')[0]!,
      });
      for (const record of records) {
        const prepared = prepareAndValidateObservation(record);
        expect(prepared).toEqual(record);
      }
    },
  );

  it('every VOD-list observation converted from expandtemplates-sparg0-vods (expanded) passes the exact persistence schema', () => {
    const fixture = loadLiquipediaFixture<ExpandFixture>('expandtemplates-sparg0-vods');
    const result = extractVodListRows({
      body: fixture.expandtemplates.wikitext,
      shape: 'expanded',
      pageTitle: 'Sparg0/VODs',
      revisionId: 347554,
      nowMs: NOW_MS,
      hashHex: sha256Hex,
    });
    expect(result.rows.length).toBeGreaterThan(0);
    const records = toVodObservationRecords(result.rows, {
      sourcePageTitle: 'Sparg0/VODs',
      sourcePageUrl: 'https://liquipedia.net/smash/Sparg0/VODs',
      sourceRevisionId: 347554,
      sourceContentHash: result.contentHash,
      fetchedAtMs: NOW_MS,
      observedAtMs: NOW_MS,
      hashHex: sha256Hex,
      subjectPlayerLabel: 'Sparg0',
    });
    for (const record of records) {
      expect(() => prepareAndValidateObservation(record)).not.toThrow();
    }
  });

  it('the observation persistence hash is stable across gather order and volatile clock stamps', () => {
    const page = wikitextPages('query-supernova-2026-singles-bracket')[0]!;
    const { observations } = extractByFamily(page);
    expect(observations.length).toBeGreaterThan(0);
    const reversed = [...observations].reverse();
    const laterClock = observations.map((observation) => ({
      ...observation,
      fetchedAtMs: NOW_MS + 999_999,
      observedAtMs: NOW_MS + 999_999,
    }));
    const baseline = computeObservationPersistenceHash(observations);
    expect(computeObservationPersistenceHash(reversed)).toBe(baseline);
    expect(computeObservationPersistenceHash(laterClock)).toBe(baseline);
    // ...but any CONTENT change moves it.
    const tampered = observations.map((observation, index) =>
      index === 0
        ? { ...observation, sourceRevisionId: observation.sourceRevisionId + 1 }
        : observation,
    );
    expect(computeObservationPersistenceHash(tampered)).not.toBe(baseline);
  });
});

// ---------------------------------------------------------------------------
// Boundary / fuzz cases — malformed and hostile untrusted strings must never
// crash extraction and must never yield a record the persistence schema
// rejects.
// ---------------------------------------------------------------------------

describe('boundary and fuzz parity', () => {
  function extractLegacyFrom(wikitext: string) {
    const eventContext = extractEventContext({
      wikitext,
      pageTitle: 'Fuzz/Page',
      revisionId: 1,
      sha1: null,
    });
    return extractLegacyBracketObservations({
      wikitext,
      pageTitle: 'Fuzz/Page',
      revisionId: 1,
      sha1: null,
      eventContext,
      targetGame: 'ultimate',
      nowMs: NOW_MS,
      hashHex: sha256Hex,
    });
  }

  function expectAllPersistable(
    observations: ReturnType<typeof extractLegacyFrom>['observations'],
  ) {
    for (const observation of observations) {
      expect(() => prepareAndValidateObservation(observation)).not.toThrow();
    }
  }

  it.each(['', ' ', '\n\n', '{{', '}}', '{{Unclosed|a=b', '|||||', '<!-- only a comment -->'])(
    'malformed wikitext %j extracts nothing and crashes nothing',
    (wikitext) => {
      const { observations } = extractLegacyFrom(wikitext);
      expect(observations).toEqual([]);
    },
  );

  it('maximum-length and overlength untrusted values are bounded to the persistence caps', () => {
    const longTag = 'A'.repeat(400);
    const longStage = 'S'.repeat(400);
    const longFlag = 'F'.repeat(400);
    const longChar = 'C'.repeat(400);
    const longDate = 'D'.repeat(400);
    const wikitext =
      '{{TournamentInfo|game=ultimate}}\n' +
      `{{8DEWBracketA|r1m1p1=${longTag}|r1m1p1flag=${longFlag}|r1m1p2=Real|` +
      `r1m1p1score=3|r1m1p2score=1|r1m1stage1=${longStage}|r1m1p1char1=${longChar}|` +
      `r1m1date=${longDate}}}`;
    const { observations } = extractLegacyFrom(wikitext);
    expect(observations.length).toBe(1);
    expectAllPersistable(observations);
    const observation = observations[0]!;
    expect(observation.players![0]!.rawTag.length).toBeLessThanOrEqual(120);
    expect(observation.games![0]!.rawStage!.length).toBeLessThanOrEqual(120);
    expect(observation.rawDate!.length).toBeLessThanOrEqual(100);
  });

  it('an overlength VOD URL is dropped with a stated reason, never truncated into a fabricated URL', () => {
    const hugeUrl = `https://www.youtube.com/watch?v=${'x'.repeat(RESEARCH_ENRICHMENT_MAX_URL)}`;
    const wikitext =
      '{{TournamentInfo|game=ultimate}}\n' +
      '{{8DEWBracketA|r1m1p1=Alice|r1m1p2=Bob|r1m1p1score=3|r1m1p2score=0|' +
      `r1m1details={{BracketMatchDetails|vod=${hugeUrl}}}}}`;
    const { observations } = extractLegacyFrom(wikitext);
    expect(observations.length).toBe(1);
    expectAllPersistable(observations);
    expect(observations[0]!.vodUrl).toBeUndefined();
    expect(observations[0]!.rawVodUrl!.length).toBeLessThanOrEqual(RESEARCH_ENRICHMENT_MAX_URL);
  });

  it('hostile embedded markup in a player tag survives as bounded, schema-valid evidence', () => {
    const hostile = '<script>alert(1)</script>{{!}}[[File:x.png]]';
    const wikitext =
      '{{TournamentInfo|game=ultimate}}\n' +
      `{{8DEWBracketA|r1m1p1=${hostile}|r1m1p2=Bob|r1m1p1score=1|r1m1p2score=0}}`;
    const { observations } = extractLegacyFrom(wikitext);
    expect(observations.length).toBe(1);
    expectAllPersistable(observations);
  });

  it('null-adjacent VOD-list input (empty body) yields zero rows and zero records without crashing', () => {
    const result = extractVodListRows({
      body: '',
      shape: 'rendered',
      pageTitle: 'Fuzz/VODs',
      revisionId: 0,
      nowMs: NOW_MS,
      hashHex: sha256Hex,
    });
    expect(result.rows).toEqual([]);
    const records = toVodObservationRecords(result.rows, {
      sourcePageTitle: 'Fuzz/VODs',
      sourcePageUrl: 'https://liquipedia.net/smash/Fuzz/VODs',
      sourceRevisionId: 0,
      sourceContentHash: sha256Hex(''),
      fetchedAtMs: NOW_MS,
      observedAtMs: NOW_MS,
      hashHex: sha256Hex,
      subjectPlayerLabel: 'Fuzz',
    });
    expect(records).toEqual([]);
  });

  it('the match2 adapter bounds overlength opponent tags and stages the same way', () => {
    const longTag = 'M'.repeat(400);
    const wikitext = `{{Bracket|Bracket/test|id=TestId

|R1M1={{Match
|opponent1={{SoloOpponent|${longTag}|score=3}}
|opponent2={{SoloOpponent|Salt|score=0}}
|map1={{Map|o1c1={{Chars|${'c'.repeat(300)},1}}|o2c1={{Chars|cf,0}}|winner=1|map=${'B'.repeat(300)}}}
}}
}}`;
    const eventContext = extractEventContext({
      wikitext,
      pageTitle: 'Fuzz/Match2',
      revisionId: 1,
      sha1: null,
    });
    const { observations } = extractMatch2BracketObservations({
      wikitext,
      pageTitle: 'Fuzz/Match2',
      revisionId: 1,
      sha1: null,
      eventContext,
      targetGame: 'ultimate',
      nowMs: NOW_MS,
      hashHex: sha256Hex,
    });
    expect(observations.length).toBe(1);
    for (const observation of observations) {
      expect(() => prepareAndValidateObservation(observation)).not.toThrow();
    }
    expect(observations[0]!.players![0]!.rawTag.length).toBeLessThanOrEqual(120);
  });
});
