import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { researchEnrichmentObservationRecordSchema } from '@smash-tracker/shared';
import { loadLiquipediaFixture } from '../__fixtures__/loadFixture.js';
import { extractEventContext, type LiquipediaEventContext } from '../eventContext.js';
import { extractLegacyBracketObservations } from './legacyBracket.js';

interface QueryRevisionFixture {
  query: {
    pages: Array<{
      revisions?: Array<{
        revid?: number;
        sha1?: string;
        slots: { main: { content: string } };
      }>;
    }>;
  };
}

function wikitextFromFixture(name: string): {
  wikitext: string;
  revisionId: number;
  sha1: string | null;
} {
  const fixture = loadLiquipediaFixture<QueryRevisionFixture>(name);
  const revision = fixture.query.pages[0]?.revisions?.[0];
  const content = revision?.slots.main.content;
  if (!content) {
    throw new Error(`fixture "${name}" has no revision content`);
  }
  return { wikitext: content, revisionId: revision.revid ?? 0, sha1: revision.sha1 ?? null };
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const NOW_MS = 1_754_000_000_000;

function supernovaEventContext(): LiquipediaEventContext {
  const { wikitext, revisionId, sha1 } = wikitextFromFixture(
    'query-supernova-2026-singles-bracket',
  );
  return extractEventContext({
    wikitext,
    pageTitle: 'Supernova/2026/Ultimate/Singles Bracket',
    revisionId,
    sha1,
  });
}

describe('extractLegacyBracketObservations', () => {
  it("extracts Sparg0's seven Supernova 2026 sets matching RESEARCH section 2.8's ground truth exactly", () => {
    const { wikitext, revisionId, sha1 } = wikitextFromFixture(
      'query-supernova-2026-singles-bracket',
    );
    const eventContext = supernovaEventContext();
    const { observations } = extractLegacyBracketObservations({
      wikitext,
      pageTitle: 'Supernova/2026/Ultimate/Singles Bracket',
      revisionId,
      sha1,
      eventContext,
      targetGame: 'ultimate',
      nowMs: NOW_MS,
      hashHex: sha256Hex,
    });

    const sparg0Sets = observations.filter((o) =>
      (o.players ?? []).some((p) => p.rawTag === 'Sparg0'),
    );

    const byKey = new Map(sparg0Sets.map((o) => [o.bracketKey, o]));

    const expected: Array<{
      bracketKey: string;
      opponent: string;
      games: number;
      vod: string;
    }> = [
      { bracketKey: '8DEWBracketA r1m1', opponent: 'Lui$', games: 5, vod: 'oXoBi4DOq6I' },
      { bracketKey: '8DEWBracketA r2m1', opponent: 'mudd', games: 5, vod: 'ZbhqaQPgMz8' },
      { bracketKey: '24DELBracketSmwA l5m2', opponent: 'Zomba', games: 4, vod: '4j5QQwozks0' },
      { bracketKey: 'DEFinalSmwBracket l1m1', opponent: 'Lima', games: 3, vod: '99xsFsX_Q2g' },
      { bracketKey: 'DEFinalSmwBracket r2m1', opponent: 'mudd', games: 4, vod: 'Cw2vsQbMT08' },
      { bracketKey: 'DEFinalSmwBracket r3m1', opponent: 'Tweek', games: 3, vod: 'pncEm1PfAJU' },
      { bracketKey: 'DEFinalSmwBracket r3m2', opponent: 'Tweek', games: 5, vod: 'pncEm1PfAJU' },
    ];

    expect(sparg0Sets.length).toBe(7);

    for (const row of expected) {
      const observation = byKey.get(row.bracketKey);
      expect(observation, `missing bracketKey ${row.bracketKey}`).toBeDefined();
      const players = observation!.players!;
      const opponents = players.map((p) => p.rawTag);
      expect(opponents).toContain('Sparg0');
      expect(opponents).toContain(row.opponent);
      expect(observation!.games?.length).toBe(row.games);
      expect(observation!.vodUrl).toContain(row.vod);
    }
  });

  it('emits the grand final and its reset as two separate records with different bracket keys, the same two player tags, and 3 and 5 games respectively', () => {
    const { wikitext, revisionId, sha1 } = wikitextFromFixture(
      'query-supernova-2026-singles-bracket',
    );
    const eventContext = supernovaEventContext();
    const { observations } = extractLegacyBracketObservations({
      wikitext,
      pageTitle: 'Supernova/2026/Ultimate/Singles Bracket',
      revisionId,
      sha1,
      eventContext,
      targetGame: 'ultimate',
      nowMs: NOW_MS,
      hashHex: sha256Hex,
    });

    const grandFinal = observations.find((o) => o.bracketKey === 'DEFinalSmwBracket r3m1');
    const reset = observations.find((o) => o.bracketKey === 'DEFinalSmwBracket r3m2');

    expect(grandFinal).toBeDefined();
    expect(reset).toBeDefined();
    expect(grandFinal!.bracketKey).not.toBe(reset!.bracketKey);
    expect(grandFinal!.games?.length).toBe(3);
    expect(reset!.games?.length).toBe(5);

    const gfTags = grandFinal!.players!.map((p) => p.rawTag).sort();
    const resetTags = reset!.players!.map((p) => p.rawTag).sort();
    expect(gfTags).toEqual(resetTags);
    expect(gfTags).toEqual(['Sparg0', 'Tweek']);

    // Total game-level stage observation count across the pair is exactly 8.
    expect((grandFinal!.games?.length ?? 0) + (reset!.games?.length ?? 0)).toBe(8);
  });

  it("carries the grand final's VOD onto the reset with an explicit inherited-from record naming the grand final's bracket key", () => {
    const { wikitext, revisionId, sha1 } = wikitextFromFixture(
      'query-supernova-2026-singles-bracket',
    );
    const eventContext = supernovaEventContext();
    const { observations } = extractLegacyBracketObservations({
      wikitext,
      pageTitle: 'Supernova/2026/Ultimate/Singles Bracket',
      revisionId,
      sha1,
      eventContext,
      targetGame: 'ultimate',
      nowMs: NOW_MS,
      hashHex: sha256Hex,
    });
    const grandFinal = observations.find((o) => o.bracketKey === 'DEFinalSmwBracket r3m1');
    const reset = observations.find((o) => o.bracketKey === 'DEFinalSmwBracket r3m2');

    expect(reset!.vodUrl).toBe(grandFinal!.vodUrl);
    expect(reset!.isBracketReset).toBe(true);
    expect(reset!.vodInheritedFromBracketKey).toBe(grandFinal!.bracketKey);
    expect(reset!.rawDate).toBe(grandFinal!.rawDate);
    expect(reset!.date).toBe(grandFinal!.date);
  });

  it("derives the reset's set winner from its scores, cross-checked against its per-game winner tally, and flags it as derived", () => {
    const { wikitext, revisionId, sha1 } = wikitextFromFixture(
      'query-supernova-2026-singles-bracket',
    );
    const eventContext = supernovaEventContext();
    const { observations } = extractLegacyBracketObservations({
      wikitext,
      pageTitle: 'Supernova/2026/Ultimate/Singles Bracket',
      revisionId,
      sha1,
      eventContext,
      targetGame: 'ultimate',
      nowMs: NOW_MS,
      hashHex: sha256Hex,
    });
    const reset = observations.find((o) => o.bracketKey === 'DEFinalSmwBracket r3m2');
    expect(reset!.scores).toEqual([2, 3]);
    expect(reset!.setWinnerSeat).toBe(2);
    expect(reset!.setWinnerDerived).toBe(true);
  });

  it('asserts no winner and records a disagreement reason when the score-derived winner and the game-tally-derived winner disagree', () => {
    // Hand-built: r1m1 has explicit scores 2-1 (seat 1 wins by score) but its
    // one recorded game row shows seat 2 winning (tally disagrees).
    const wikitext = `{{TournamentInfo
|game=ultimate
}}
{{8DEWBracketA
|r1m1p1=Alice |r1m1p1flag=us |r1m1p1score=2
|r1m1p2=Bob |r1m1p2flag=us |r1m1p2score=1
|r1m1p1char1=mario |r1m1p2char1=luigi |r1m1p1stock1=0 |r1m1p2stock1=3 |r1m1win1=2 |r1m1stage1=Battlefield
|r1m1date=August 9, 2026
}}`;
    const eventContext = extractEventContext({
      wikitext,
      pageTitle: 'Test/Disagreement',
      revisionId: 1,
      sha1: null,
    });
    const { observations } = extractLegacyBracketObservations({
      wikitext,
      pageTitle: 'Test/Disagreement',
      revisionId: 1,
      sha1: null,
      eventContext,
      targetGame: 'ultimate',
      nowMs: NOW_MS,
      hashHex: sha256Hex,
    });
    const observation = observations[0]!;
    expect(observation.setWinnerSeat).toBeUndefined();
    expect(
      observation.resolutionReasons?.some((r) => r.toLowerCase().includes('disagreement')),
    ).toBe(true);
  });

  it('emits an extraction-failure record — never a playerless set — for a hand-built group with games but no player tags and no eligible sibling', () => {
    const wikitext = `{{TournamentInfo
|game=ultimate
}}
{{8DEWBracketA
|r5m3p1char1=mario |r5m3p2char1=luigi |r5m3p1stock1=1 |r5m3p2stock1=0 |r5m3win1=1 |r5m3stage1=Battlefield
|r5m3p1score=2 |r5m3p2score=1
}}`;
    const eventContext = extractEventContext({
      wikitext,
      pageTitle: 'Test/NoSibling',
      revisionId: 1,
      sha1: null,
    });
    const { observations } = extractLegacyBracketObservations({
      wikitext,
      pageTitle: 'Test/NoSibling',
      revisionId: 1,
      sha1: null,
      eventContext,
      targetGame: 'ultimate',
      nowMs: NOW_MS,
      hashHex: sha256Hex,
    });
    expect(observations.length).toBe(1);
    const observation = observations[0]!;
    expect(observation.extractionFailed).toBe(true);
    expect(observation.players).toBeUndefined();
    expect(observation.resolutionReasons?.length).toBeGreaterThan(0);
  });

  it('preserves non-numeric scores raw with a null numeric value and a stated reason; a disqualification set and a walkover set both survive extraction', () => {
    const { wikitext, revisionId, sha1 } = wikitextFromFixture(
      'query-supernova-2026-singles-bracket',
    );
    const eventContext = supernovaEventContext();
    const { observations } = extractLegacyBracketObservations({
      wikitext,
      pageTitle: 'Supernova/2026/Ultimate/Singles Bracket',
      revisionId,
      sha1,
      eventContext,
      targetGame: 'ultimate',
      nowMs: NOW_MS,
      hashHex: sha256Hex,
    });
    const dqSet = observations.find((o) => o.bracketKey === '8DEWBracketA r1m3');
    expect(dqSet).toBeDefined();
    expect(dqSet!.rawScores).toEqual(['{{win}}', 'DQ']);
    expect(dqSet!.scores).toEqual([null, null]);
    expect(dqSet!.resolutionReasons?.length).toBeGreaterThan(0);
  });

  it('canonicalizes every game stage independently, preserving the raw string and the form alongside the canonical id, with an unmapped stage yielding a null id and the raw string intact', () => {
    const { wikitext, revisionId, sha1 } = wikitextFromFixture(
      'query-supernova-2026-singles-bracket',
    );
    const eventContext = supernovaEventContext();
    const { observations } = extractLegacyBracketObservations({
      wikitext,
      pageTitle: 'Supernova/2026/Ultimate/Singles Bracket',
      revisionId,
      sha1,
      eventContext,
      targetGame: 'ultimate',
      nowMs: NOW_MS,
      hashHex: sha256Hex,
    });
    const set = observations.find((o) => o.bracketKey === '8DEWBracketA r1m1')!;
    const hazardlessGame = set.games!.find((g) => g.rawStage === 'Φ Town and City')!;
    expect(hazardlessGame.stageForm).toBe('hazardless');
    expect(hazardlessGame.canonicalStageId).not.toBeNull();

    // Unmapped stage: a fabricated symbol never observed on the wiki.
    const unknownWikitext = `{{TournamentInfo
|game=ultimate
}}
{{8DEWBracketA
|r1m1p1=A |r1m1p2=B |r1m1p1score=1 |r1m1p2score=0 |r1m1win=1
|r1m1p1char1=mario |r1m1p2char1=luigi |r1m1p1stock1=1 |r1m1p2stock1=0 |r1m1win1=1 |r1m1stage1=Ψ Nonexistent Stage
}}`;
    const unknownContext = extractEventContext({
      wikitext: unknownWikitext,
      pageTitle: 'Test/Unmapped',
      revisionId: 1,
      sha1: null,
    });
    const { observations: unknownObservations } = extractLegacyBracketObservations({
      wikitext: unknownWikitext,
      pageTitle: 'Test/Unmapped',
      revisionId: 1,
      sha1: null,
      eventContext: unknownContext,
      targetGame: 'ultimate',
      nowMs: NOW_MS,
      hashHex: sha256Hex,
    });
    const unmapped = unknownObservations[0]!;
    expect(unmapped.games![0]!.canonicalStageId).toBeNull();
    expect(unmapped.games![0]!.rawStage).toBe('Ψ Nonexistent Stage');
  });

  it('never assumes seat order is player-stable: the same player occupies different seats in different sets of the same fixture, both extracted correctly', () => {
    const { wikitext, revisionId, sha1 } = wikitextFromFixture(
      'query-supernova-2026-singles-bracket',
    );
    const eventContext = supernovaEventContext();
    const { observations } = extractLegacyBracketObservations({
      wikitext,
      pageTitle: 'Supernova/2026/Ultimate/Singles Bracket',
      revisionId,
      sha1,
      eventContext,
      targetGame: 'ultimate',
      nowMs: NOW_MS,
      hashHex: sha256Hex,
    });
    const r1m1 = observations.find((o) => o.bracketKey === '8DEWBracketA r1m1')!;
    const r2m1 = observations.find((o) => o.bracketKey === '8DEWBracketA r2m1')!;
    // Sparg0 is p1 in r1m1 but the RAW tag ordering flips relative to the
    // grand final's own record — assert both extractions read a correct,
    // independent seat assignment rather than assuming a fixed index.
    expect(r1m1.players![0]!.rawTag).toBe('Sparg0');
    expect(r2m1.players![0]!.rawTag).toBe('Sparg0');
    const grandFinal = observations.find((o) => o.bracketKey === 'DEFinalSmwBracket r3m1')!;
    expect(grandFinal.players![1]!.rawTag).toBe('Sparg0');
  });

  it('extracts the pools fixture through the same adapter, including its two-digit match indices and its bye opponents', () => {
    const { wikitext, revisionId, sha1 } = wikitextFromFixture('query-scu-singles-pools-a3');
    const eventContext = extractEventContext({
      wikitext,
      pageTitle: 'Smash Conference United/Ultimate/Singles Pools/A3',
      revisionId,
      sha1,
    });
    const { observations } = extractLegacyBracketObservations({
      wikitext,
      pageTitle: 'Smash Conference United/Ultimate/Singles Pools/A3',
      revisionId,
      sha1,
      eventContext,
      targetGame: 'ultimate',
      nowMs: NOW_MS,
      hashHex: sha256Hex,
    });
    const twoDigit = observations.find((o) => o.bracketKey === '32DEWBracketA r1m10');
    expect(twoDigit).toBeDefined();
    expect(twoDigit!.players!.map((p) => p.rawTag)).toContain('Tremendo Dude');

    const byeSet = observations.find((o) => o.bracketKey === '32DEWBracketA r1m1');
    expect(byeSet).toBeDefined();
    expect(byeSet!.players!.map((p) => p.rawTag)).toContain('Bye');
  });

  it('carries source page title, source page URL, revision id, sha1, content hash, parser version, template family, bracket template and bracket key on every emitted record', () => {
    const { wikitext, revisionId, sha1 } = wikitextFromFixture(
      'query-supernova-2026-singles-bracket',
    );
    const eventContext = supernovaEventContext();
    const { observations } = extractLegacyBracketObservations({
      wikitext,
      pageTitle: 'Supernova/2026/Ultimate/Singles Bracket',
      revisionId,
      sha1,
      eventContext,
      targetGame: 'ultimate',
      nowMs: NOW_MS,
      hashHex: sha256Hex,
    });
    for (const observation of observations) {
      expect(observation.sourcePageTitle).toBe('Supernova/2026/Ultimate/Singles Bracket');
      expect(observation.sourcePageUrl).toContain('liquipedia.net/smash/');
      expect(observation.sourceRevisionId).toBe(revisionId);
      expect(observation.sourceSha1).toBe(sha1);
      expect(observation.sourceContentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(observation.parserVersion).toBe('liquipedia-bracket-legacy@1');
      expect(observation.templateFamily).toBe('legacy');
      expect(observation.bracketTemplate).toBeTruthy();
      expect(observation.bracketKey).toBeTruthy();
      const parsed = researchEnrichmentObservationRecordSchema.safeParse(observation);
      expect(parsed.success).toBe(true);
    }
  });

  it('sets matchingStatus to the unmatched value on every emitted record', () => {
    const { wikitext, revisionId, sha1 } = wikitextFromFixture(
      'query-supernova-2026-singles-bracket',
    );
    const eventContext = supernovaEventContext();
    const { observations } = extractLegacyBracketObservations({
      wikitext,
      pageTitle: 'Supernova/2026/Ultimate/Singles Bracket',
      revisionId,
      sha1,
      eventContext,
      targetGame: 'ultimate',
      nowMs: NOW_MS,
      hashHex: sha256Hex,
    });
    expect(observations.length).toBeGreaterThan(0);
    for (const observation of observations) {
      expect(observation.matchingStatus).toBe('unmatched');
    }
  });
});
