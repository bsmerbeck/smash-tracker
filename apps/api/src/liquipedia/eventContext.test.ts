import { describe, expect, it } from 'vitest';
import { loadLiquipediaFixture } from './__fixtures__/loadFixture.js';
import { extractEventContext } from './eventContext.js';

interface QueryRevisionFixture {
  query: {
    pages: Array<{
      pageid?: number;
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
  const page = fixture.query.pages[0];
  const revision = page?.revisions?.[0];
  const content = revision?.slots.main.content;
  if (!content) {
    throw new Error(`fixture "${name}" has no revision content`);
  }
  return {
    wikitext: content,
    revisionId: revision.revid ?? 0,
    sha1: revision.sha1 ?? null,
  };
}

describe('extractEventContext', () => {
  it('reads the modern start.gg slug parameter from the Supernova tournament fixture', () => {
    const { wikitext, revisionId, sha1 } = wikitextFromFixture('query-supernova-2026-tournament');
    const context = extractEventContext({
      wikitext,
      pageTitle: 'Supernova/2026/Ultimate',
      revisionId,
      sha1,
    });
    expect(context.startggSlug).toBe('supernova-2026');
    expect(context.startggSlugKey).toBe('startgg');
    expect(context.game).toBe('ultimate');
    expect(context.tournamentDisplayName).toBe('Supernova 2026');
    expect(context.startDateIso).toBe('2026-08-06');
    expect(context.endDateIso).toBe('2026-08-09');
  });

  it('reads the legacy smashgg slug parameter from the Super Smash Con 2019 fixture, producing the same normalized shape', () => {
    const { wikitext, revisionId, sha1 } = wikitextFromFixture('query-ssc-2019-ultimate');
    const context = extractEventContext({
      wikitext,
      pageTitle: 'Super Smash Con/2019/Ultimate',
      revisionId,
      sha1,
    });
    expect(context.startggSlug).toBe('super-smash-con-2019');
    expect(context.startggSlugKey).toBe('smashgg');
  });

  it('normalizes a startgg= raw value and a smashgg= raw value carrying the same path to an identical slug', () => {
    const startggInput = extractEventContext({
      wikitext: '{{Infobox league\n|game=ultimate\n|startgg=tournament/same-event/details\n}}',
      pageTitle: 'Test/StartGG',
      revisionId: 1,
      sha1: null,
    });
    const smashggInput = extractEventContext({
      wikitext: '{{Infobox league\n|game=ultimate\n|smashgg=tournament/same-event/details\n}}',
      pageTitle: 'Test/SmashGG',
      revisionId: 1,
      sha1: null,
    });
    expect(startggInput.startggSlug).toBe('same-event');
    expect(smashggInput.startggSlug).toBe('same-event');
    expect(startggInput.startggSlug).toBe(smashggInput.startggSlug);
    expect(startggInput.startggSlugKey).toBe('startgg');
    expect(smashggInput.startggSlugKey).toBe('smashgg');
  });

  it('strips the (CP) counterpick suffix from the ruleset stage list and preserves the Φ hazardless prefix, never canonicalizing', () => {
    const { wikitext, revisionId, sha1 } = wikitextFromFixture('query-ssc-2019-ultimate');
    const context = extractEventContext({
      wikitext,
      pageTitle: 'Super Smash Con/2019/Ultimate',
      revisionId,
      sha1,
    });
    expect(context.rulesetStageRaw).toContain('Φ Kalos Pokémon League');
    expect(context.rulesetStageRaw).not.toContain('Φ Kalos Pokémon League (CP)');
    expect(context.rulesetStageRaw).toContain('Battlefield');
    expect(context.rulesetStageRaw.length).toBe(8);
  });

  it('yields a null slug with a stated, non-empty reason when a page carries neither the startgg nor the smashgg key', () => {
    const context = extractEventContext({
      wikitext: '{{TournamentInfo\n|game=ultimate\n|tourneylink=Some/Tournament\n}}',
      pageTitle: 'Some/Tournament/Bracket',
      revisionId: 42,
      sha1: 'deadbeef',
    });
    expect(context.startggSlug).toBeNull();
    expect(context.startggSlugKey).toBeNull();
    expect(context.reasons.length).toBeGreaterThan(0);
    expect(context.reasons.some((r) => r.toLowerCase().includes('slug'))).toBe(true);
  });

  it("reads the declared game scope, the parent tournament link, the display name, the phase, and the editor-declared alias remap from the bracket page's TournamentInfo block", () => {
    const { wikitext, revisionId, sha1 } = wikitextFromFixture(
      'query-supernova-2026-singles-bracket',
    );
    const context = extractEventContext({
      wikitext,
      pageTitle: 'Supernova/2026/Ultimate/Singles Bracket',
      revisionId,
      sha1,
    });
    expect(context.game).toBe('ultimate');
    expect(context.tournamentPageTitle).toBe('Supernova/2026/Ultimate');
    expect(context.tournamentDisplayName).toBe('Supernova 2026');
    expect(context.phase).toBe('4');
    expect(context.aliasRemaps).toEqual([{ oldTag: 'Light', newTag: 'Light (American player)' }]);
  });

  it('falls back to the page title itself when no parent tourneylink is present', () => {
    const context = extractEventContext({
      wikitext: '{{Infobox league\n|game=ultimate\n|startgg=tournament/foo/details\n}}',
      pageTitle: 'Foo/2026/Ultimate',
      revisionId: 1,
      sha1: null,
    });
    expect(context.tournamentPageTitle).toBe('Foo/2026/Ultimate');
  });

  it('entity-decodes and markup-strips display strings so an escaped apostrophe compares equal to the same title read from raw wikitext', () => {
    const escaped = extractEventContext({
      wikitext:
        '{{Infobox league\n|game=ultimate\n|name=Player&#39;s Event\n|startgg=tournament/apos/details\n}}',
      pageTitle: 'Apos/Event',
      revisionId: 1,
      sha1: null,
    });
    const raw = extractEventContext({
      wikitext:
        "{{Infobox league\n|game=ultimate\n|name=Player's Event\n|startgg=tournament/apos/details\n}}",
      pageTitle: 'Apos/Event',
      revisionId: 1,
      sha1: null,
    });
    expect(escaped.tournamentDisplayName).toBe("Player's Event");
    expect(escaped.tournamentDisplayName).toBe(raw.tournamentDisplayName);
  });

  it('returns the source page title, its constructed article URL and its revision id on every result', () => {
    const { wikitext, revisionId, sha1 } = wikitextFromFixture('query-supernova-2026-tournament');
    const context = extractEventContext({
      wikitext,
      pageTitle: 'Supernova/2026/Ultimate',
      revisionId,
      sha1,
    });
    expect(context.pageTitle).toBe('Supernova/2026/Ultimate');
    expect(context.pageUrl).toBe('https://liquipedia.net/smash/Supernova/2026/Ultimate');
    expect(context.revisionId).toBe(revisionId);
    expect(context.sha1).toBe(sha1);
  });
});
