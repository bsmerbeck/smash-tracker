import { describe, expect, it } from 'vitest';
import {
  researchEnrichmentAttributionEntrySchema,
  researchEnrichmentFieldCoverageSchema,
  type ResearchEnrichmentAttributionEntry,
  type ResearchEnrichmentFieldCoverage,
} from '@smash-tracker/shared';
import {
  enrichmentCharacterAttributionSchema,
  enrichmentStockAttributionSchema,
  webEnrichmentAttributionEntrySchema,
  webEnrichmentAttributionResponseSchema,
} from './enrichmentEvidence';
import {
  ENRICHMENT_FIELD_COVERAGE_FIELDS,
  selectFieldCoverageCell,
} from './enrichmentFieldCoverage';

/**
 * MANDATORY cross-package contract test (30.3-web brief, item 4): this is
 * the ONE test in this worktree that imports the shared package's SCHEMAS
 * (not just its inferred types) and round-trips a shared-schema-VALID
 * attribution entry + fieldCoverage object through this package's own
 * web-side parsing/rendering shapes, pinning every field name by exact
 * string. A rename, a drop, or a silent zod-strip of any shared field on
 * either side of this file must fail one of the assertions below — that is
 * the whole point of the test (a real defect between two parallel Gate-5
 * agents was caught this way once already).
 */

/** A shared-schema-VALID attribution entry, built from nothing but members `researchEnrichmentAttributionEntrySchema` (packages/shared) itself declares — proven valid against that schema, not assumed. */
function sharedBuiltAttributionEntry(): ResearchEnrichmentAttributionEntry {
  const entry = {
    matchKey: 'contract-test-match-1',
    stage: {
      sourcePageTitle: 'Contract Test Bracket Page',
      sourcePageUrl: 'https://liquipedia.net/smash/Contract_Test_Bracket_Page',
      sourceRevisionId: 424242,
      rawStage: 'Φ Town and City',
      stageForm: 'hazardless' as const,
    },
    vod: {
      sourcePageTitle: 'Contract Test VOD Page',
      sourcePageUrl: 'https://liquipedia.net/smash/Contract_Test_VOD_Page',
      sourceRevisionId: 424243,
    },
  };
  // Proves the fixture is genuinely shared-schema-valid before it is used to
  // test anything web-side — a fixture that only ever satisfied the WEB
  // schema would prove nothing about the shared contract.
  return researchEnrichmentAttributionEntrySchema.parse(entry);
}

/** A shared-schema-VALID field-coverage rollup, built from nothing but members `researchEnrichmentFieldCoverageSchema` (packages/shared) itself declares. */
function sharedBuiltFieldCoverage(): ResearchEnrichmentFieldCoverage {
  const cell = (present: number, missing: number, ambiguous: number) => ({
    present,
    missing,
    ambiguous,
    latestSourceRevisionId: 909090,
    latestProjectedAtMs: 1_770_000_000_000,
  });
  const coverage = {
    asOfMs: 1_770_000_000_000,
    witnessedRows: 40,
    stages: cell(10, 2, 1),
    characters: cell(8, 3, 2),
    stocks: cell(6, 5, 1),
    vods: cell(9, 1, 0),
  };
  return researchEnrichmentFieldCoverageSchema.parse(coverage);
}

describe('enrichmentEvidence — cross-package contract (Phase 30.3 Gate 5)', () => {
  describe('attribution entry round-trip', () => {
    it('preserves every shared matchKey/stage/vod field through the web-extended schema, by exact field name', () => {
      const shared = sharedBuiltAttributionEntry();
      const parsed = webEnrichmentAttributionEntrySchema.parse(shared);

      expect(parsed.matchKey).toBe(shared.matchKey);
      expect(parsed.stage?.sourcePageTitle).toBe(shared.stage?.sourcePageTitle);
      expect(parsed.stage?.sourcePageUrl).toBe(shared.stage?.sourcePageUrl);
      expect(parsed.stage?.sourceRevisionId).toBe(shared.stage?.sourceRevisionId);
      expect(parsed.stage?.rawStage).toBe(shared.stage?.rawStage);
      expect(parsed.stage?.stageForm).toBe(shared.stage?.stageForm);
      expect(parsed.vod?.sourcePageTitle).toBe(shared.vod?.sourcePageTitle);
      expect(parsed.vod?.sourcePageUrl).toBe(shared.vod?.sourcePageUrl);
      expect(parsed.vod?.sourceRevisionId).toBe(shared.vod?.sourceRevisionId);

      // Defensive rendering (brief item 5): a shared entry with no
      // characters/stocks parses with both absent, never fabricated.
      expect(parsed.characters).toBeUndefined();
      expect(parsed.stocks).toBeUndefined();
    });

    it('round-trips a full response array (matchKey/stage/vod) through the web response schema unchanged', () => {
      const shared = sharedBuiltAttributionEntry();
      const parsed = webEnrichmentAttributionResponseSchema.parse({ attributions: [shared] });
      expect(parsed.attributions).toHaveLength(1);
      expect(parsed.attributions[0]!.matchKey).toBe(shared.matchKey);
      expect(parsed.attributions[0]!.vod?.sourcePageUrl).toBe(shared.vod?.sourcePageUrl);
    });

    // Written while the API-side schema extension was still in a parallel
    // worktree, this test originally demonstrated the strip the web extension
    // guards against. The shared schema NOW carries the characters/stocks
    // halves natively (30.3 integration), so the contract strengthened: BOTH
    // schemas must preserve the halves identically — a divergence in either
    // direction fails here.
    it('shared and web schemas both preserve characters/stocks identically (post-integration contract)', () => {
      const withEvidence = {
        ...sharedBuiltAttributionEntry(),
        characters: {
          subjectRaw: 'Mario',
          opponentRaw: 'Luigi',
          subjectFighterId: 1,
          opponentFighterId: 10,
        },
        stocks: { stocksLeft: 2 },
      };

      const throughSharedSchema = researchEnrichmentAttributionEntrySchema.parse(withEvidence) as {
        characters?: unknown;
        stocks?: unknown;
      };
      expect(throughSharedSchema.characters).toEqual(withEvidence.characters);
      expect(throughSharedSchema.stocks).toEqual(withEvidence.stocks);

      const throughWebSchema = webEnrichmentAttributionEntrySchema.parse(withEvidence);
      expect(throughWebSchema.characters?.subjectRaw).toBe('Mario');
      expect(throughWebSchema.characters?.opponentRaw).toBe('Luigi');
      expect(throughWebSchema.characters?.subjectFighterId).toBe(1);
      expect(throughWebSchema.characters?.opponentFighterId).toBe(10);
      expect(throughWebSchema.stocks?.stocksLeft).toBe(2);
    });

    it('pins every characters/stocks field name the literal contract specifies, each half also carrying the shared source-page identity members', () => {
      const entry = {
        matchKey: 'contract-test-match-2',
        characters: {
          subjectRaw: 'Mario',
          opponentRaw: 'Luigi',
          subjectFighterId: 1,
          opponentFighterId: 10,
          sourcePageTitle: 'Contract Test Bracket Page',
          sourcePageUrl: 'https://liquipedia.net/smash/Contract_Test_Bracket_Page',
          sourceRevisionId: 424242,
        },
        stocks: {
          stocksLeft: 1,
          sourcePageTitle: 'Contract Test Bracket Page',
          sourcePageUrl: 'https://liquipedia.net/smash/Contract_Test_Bracket_Page',
          sourceRevisionId: 424242,
        },
      };
      const parsed = webEnrichmentAttributionEntrySchema.parse(entry);

      expect(parsed.characters).toEqual({
        subjectRaw: 'Mario',
        opponentRaw: 'Luigi',
        subjectFighterId: 1,
        opponentFighterId: 10,
        sourcePageTitle: 'Contract Test Bracket Page',
        sourcePageUrl: 'https://liquipedia.net/smash/Contract_Test_Bracket_Page',
        sourceRevisionId: 424242,
      });
      expect(parsed.stocks).toEqual({
        stocksLeft: 1,
        sourcePageTitle: 'Contract Test Bracket Page',
        sourcePageUrl: 'https://liquipedia.net/smash/Contract_Test_Bracket_Page',
        sourceRevisionId: 424242,
      });
    });

    it('accepts characters/stocks with no source-page identity at all (the literal API contract: subjectRaw/opponentRaw/*FighterId, stocksLeft only)', () => {
      const parsed = enrichmentCharacterAttributionSchema.parse({
        subjectRaw: 'Mario',
        opponentRaw: 'Luigi',
      });
      expect(parsed).toEqual({ subjectRaw: 'Mario', opponentRaw: 'Luigi' });

      const stocks = enrichmentStockAttributionSchema.parse({ stocksLeft: 3 });
      expect(stocks).toEqual({ stocksLeft: 3 });
    });
  });

  describe('field coverage round-trip', () => {
    it('preserves every shared field-coverage member through the web-side rendering selector, by exact field name, for every rolled-up field', () => {
      const shared = sharedBuiltFieldCoverage();

      for (const field of ENRICHMENT_FIELD_COVERAGE_FIELDS) {
        const sharedCell = shared[field];
        const rendered = selectFieldCoverageCell(shared, field);
        expect(rendered.present).toBe(sharedCell.present);
        expect(rendered.missing).toBe(sharedCell.missing);
        expect(rendered.ambiguous).toBe(sharedCell.ambiguous);
        expect(rendered.latestSourceRevisionId).toBe(sharedCell.latestSourceRevisionId);
        expect(rendered.latestProjectedAtMs).toBe(sharedCell.latestProjectedAtMs);
      }
    });

    it('covers exactly the four fields the shared schema rolls up — stages, characters, stocks, vods', () => {
      expect([...ENRICHMENT_FIELD_COVERAGE_FIELDS].sort()).toEqual(
        ['characters', 'stages', 'stocks', 'vods'].sort(),
      );
    });

    it('renders a zero cell honestly (missing stays missing, never omitted)', () => {
      const shared = researchEnrichmentFieldCoverageSchema.parse({
        asOfMs: 1_770_000_000_000,
        witnessedRows: 5,
        stages: { present: 0, missing: 5, ambiguous: 0 },
        characters: { present: 0, missing: 5, ambiguous: 0 },
        stocks: { present: 0, missing: 5, ambiguous: 0 },
        vods: { present: 0, missing: 5, ambiguous: 0 },
      });
      const rendered = selectFieldCoverageCell(shared, 'characters');
      expect(rendered).toEqual({
        present: 0,
        missing: 5,
        ambiguous: 0,
        latestSourceRevisionId: undefined,
        latestProjectedAtMs: undefined,
      });
    });
  });
});
