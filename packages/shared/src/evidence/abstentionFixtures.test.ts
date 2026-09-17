import { describe, expect, it } from 'vitest';
import { buildStageEvidence } from './stageEvidence.js';
import { buildMatchupEvidence } from './matchupEvidence.js';
import { buildOpponentEvidence, buildOpponentProfile } from './opponentEvidence.js';
import { ABSTENTION_FLOOR_GAMES, confidenceTierFor } from './policy.js';
import { normalizeOpponentTag } from './identity.js';
import type { Match } from '../match.js';
import {
  emptyWorkspace,
  oneGameWorkspace,
  twoGameWorkspace,
  unknownStageOnlyWorkspace,
  unknownCharacterOnlyWorkspace,
  generateSyntheticMatches,
  EIGHT_K_FIXTURE_OPTIONS,
} from '../testUtils/index.js';

/**
 * FIXT-02's actual deliverable: the proof that the abstention path, the
 * unknown bucket, and the EVID-12 alias merge work on cold-start and
 * synthetic fixtures — asserted against the engine's own public entry
 * points, never against a constant or a prose claim.
 *
 * What these fixtures prove, and what they do NOT: the generator (plan
 * 36-05 Task 1) produces data SHAPED like a multi-character player's
 * history — 2-3 dominant fighters plus a long tail, exercised here via
 * per-character-pair rows and an alias-merged identity. They prove nothing
 * about MkLeo's or Sparg0's real accounts, which D-20 forbids any
 * autonomous task in this phase from reading. ROADMAP SC1's named-account
 * clause is closed by the owner/Codex browser-UAT items in plan 36-02's
 * `<human-check>`, never by this suite passing (R1-MEDIUM-6).
 */

const REFRESHED_AT = 1_700_000_500_000;

describe('self-check: fixture builders return their documented row counts', () => {
  it('every sparse workspace builder returns its expected count, so an emptied builder cannot make the rest of this suite vacuous', () => {
    expect(emptyWorkspace()).toHaveLength(0);
    expect(oneGameWorkspace()).toHaveLength(1);
    expect(twoGameWorkspace()).toHaveLength(2);
    expect(unknownStageOnlyWorkspace()).toHaveLength(5);
    expect(unknownCharacterOnlyWorkspace()).toHaveLength(5);
  });
});

describe('EVID-03/D-05 abstention boundary on cold-start fixtures', () => {
  it('buildStageEvidence and buildMatchupEvidence abstain over emptyWorkspace() with raw sample size 0 and games-needed 3, throwing nothing', () => {
    const matches = emptyWorkspace();
    expect(() => buildStageEvidence({ matches, refreshedAt: REFRESHED_AT })).not.toThrow();
    expect(() => buildMatchupEvidence({ matches, refreshedAt: REFRESHED_AT })).not.toThrow();

    const stage = buildStageEvidence({ matches, refreshedAt: REFRESHED_AT });
    const matchup = buildMatchupEvidence({ matches, refreshedAt: REFRESHED_AT });

    expect(stage.claim.kind).toBe('abstained');
    expect(stage.claim.sample.rawSampleSize).toBe(0);
    expect(stage.claim.kind === 'abstained' && stage.claim.gamesNeeded).toBe(
      ABSTENTION_FLOOR_GAMES,
    );

    expect(matchup.claim.kind).toBe('abstained');
    expect(matchup.claim.sample.rawSampleSize).toBe(0);
    expect(matchup.claim.kind === 'abstained' && matchup.claim.gamesNeeded).toBe(
      ABSTENTION_FLOOR_GAMES,
    );
  });

  it('abstains over oneGameWorkspace() with a games-needed of 2', () => {
    const matches = oneGameWorkspace();
    const stage = buildStageEvidence({ matches, refreshedAt: REFRESHED_AT });
    const matchup = buildMatchupEvidence({ matches, refreshedAt: REFRESHED_AT });

    expect(stage.claim.kind).toBe('abstained');
    expect(stage.claim.kind === 'abstained' && stage.claim.gamesNeeded).toBe(2);
    expect(matchup.claim.kind).toBe('abstained');
    expect(matchup.claim.kind === 'abstained' && matchup.claim.gamesNeeded).toBe(2);
  });

  it('abstains over twoGameWorkspace() with a games-needed of 1', () => {
    const matches = twoGameWorkspace();
    const stage = buildStageEvidence({ matches, refreshedAt: REFRESHED_AT });
    const matchup = buildMatchupEvidence({ matches, refreshedAt: REFRESHED_AT });

    expect(stage.claim.kind).toBe('abstained');
    expect(stage.claim.kind === 'abstained' && stage.claim.gamesNeeded).toBe(1);
    expect(matchup.claim.kind).toBe('abstained');
    expect(matchup.claim.kind === 'abstained' && matchup.claim.gamesNeeded).toBe(1);
  });

  it('does NOT abstain over a three-countable-game workspace built from the generator, and reports the low confidence tier', () => {
    const matches = generateSyntheticMatches({
      seed: 909,
      count: 3,
      mainFighterIds: [8],
      mainFighterShare: 1,
      opponentFighterIds: [23],
      stageIds: [1],
      unknownStageRate: 0,
      winRate: 1,
    });
    expect(matches).toHaveLength(3);

    const stage = buildStageEvidence({ matches, refreshedAt: REFRESHED_AT });
    const matchup = buildMatchupEvidence({ matches, refreshedAt: REFRESHED_AT });

    expect(stage.claim.kind).toBe('evidenced');
    expect(stage.claim.sample.confidenceTier).toBe('low');
    expect(confidenceTierFor(3)).toBe('low');

    expect(matchup.claim.kind).toBe('evidenced');
    expect(matchup.claim.sample.confidenceTier).toBe('low');
  });
});

describe('EVID-11/D-09 unknown buckets on cold-start fixtures', () => {
  it('unknownStageOnlyWorkspace(): the stage claim abstains and reports a non-null unknown bucket sized to the workspace, with raw-minus-unknown equal to eligible', () => {
    const matches = unknownStageOnlyWorkspace();
    const stage = buildStageEvidence({ matches, refreshedAt: REFRESHED_AT });

    expect(stage.claim.kind).toBe('abstained');
    expect(stage.unknown).not.toBeNull();
    expect(stage.unknown?.games).toBe(matches.length);
    expect(stage.claim.sample.rawSampleSize - (stage.unknown?.games ?? 0)).toBe(
      stage.claim.sample.eligibleDenominator,
    );
  });

  it('unknownCharacterOnlyWorkspace(): the character-pair claim abstains and reports a non-null unknown bucket', () => {
    const matches = unknownCharacterOnlyWorkspace();
    const matchup = buildMatchupEvidence({ matches, refreshedAt: REFRESHED_AT });

    expect(matchup.claim.kind).toBe('abstained');
    expect(matchup.unknown).not.toBeNull();
    expect(matchup.unknown?.games).toBe(matches.length);
    expect(matchup.claim.sample.rawSampleSize - (matchup.unknown?.games ?? 0)).toBe(
      matchup.claim.sample.eligibleDenominator,
    );
  });

  it('a fully-known workspace produces a null unknown bucket on both axes', () => {
    const matches = generateSyntheticMatches({
      seed: 42,
      count: 100,
      unknownStageRate: 0,
    });
    const stage = buildStageEvidence({ matches, refreshedAt: REFRESHED_AT });
    const matchup = buildMatchupEvidence({ matches, refreshedAt: REFRESHED_AT });
    expect(stage.unknown).toBeNull();
    expect(matchup.unknown).toBeNull();
  });
});

describe('the 8000-game fixture (SCL-01 shape) is evidenced at the high confidence tier', () => {
  const eightK = generateSyntheticMatches(EIGHT_K_FIXTURE_OPTIONS);
  const stage = buildStageEvidence({ matches: eightK, refreshedAt: REFRESHED_AT });
  const matchup = buildMatchupEvidence({ matches: eightK, refreshedAt: REFRESHED_AT });

  it('both claims are evidenced at the high confidence tier', () => {
    expect(stage.claim.kind).toBe('evidenced');
    expect(stage.claim.sample.confidenceTier).toBe('high');
    expect(matchup.claim.kind).toBe('evidenced');
    expect(matchup.claim.sample.confidenceTier).toBe('high');
  });

  it('the stage claim reports a non-null unknown bucket, because the generator emits unknown-stage rows, with raw-minus-unknown equal to eligible', () => {
    expect(stage.unknown).not.toBeNull();
    expect(stage.unknown!.games).toBeGreaterThan(0);
    expect(stage.claim.sample.rawSampleSize - stage.unknown!.games).toBe(
      stage.claim.sample.eligibleDenominator,
    );
  });
});

describe('EVID-12 alias merge (FIXT-02 fixture-level proof)', () => {
  const ALIAS_TAGS: [string, string] = ['shadowfox', 'nightowl'];
  const ALIAS_SLUG = 'user/abc123';

  function aliasFixture(): Match[] {
    return generateSyntheticMatches({
      seed: 555,
      count: 300,
      aliasSplitOpponentTags: ALIAS_TAGS,
      aliasSplitOpponentSlug: ALIAS_SLUG,
    });
  }

  it('buildOpponentEvidence merges the alias-split identity into exactly one row with a merging alias map, and two rows with an empty one', () => {
    const matches = aliasFixture();
    const canonicalTag1 = normalizeOpponentTag(ALIAS_TAGS[0]);
    const canonicalTag2 = normalizeOpponentTag(ALIAS_TAGS[1]);
    expect(canonicalTag1).not.toBe(canonicalTag2);

    const mergingAliasMap: Record<string, string> = { [canonicalTag2]: canonicalTag1 };
    const merged = buildOpponentEvidence({
      matches,
      aliasMap: mergingAliasMap,
      refreshedAt: REFRESHED_AT,
    });
    const mergedRows = merged.rows.filter((r) => r.identity === canonicalTag1);
    expect(mergedRows).toHaveLength(1);
    expect(mergedRows[0]!.total).toBe(8); // 3 tag1 + 3 tag2 (merged) + 1 slug-only + 1 binding

    const unmerged = buildOpponentEvidence({ matches, aliasMap: {}, refreshedAt: REFRESHED_AT });
    const tag1Row = unmerged.rows.find((r) => r.identity === canonicalTag1);
    const tag2Row = unmerged.rows.find((r) => r.identity === canonicalTag2);
    expect(tag1Row).toBeDefined();
    expect(tag2Row).toBeDefined();
    expect(tag1Row!.total).toBe(5); // 3 tag1 + 1 slug-only + 1 binding (all resolve via tag1)
    expect(tag2Row!.total).toBe(3); // 3 pure tag2 rows
  });

  it('buildOpponentProfile returns one continuous chronological series spanning both tags with the merging alias map', () => {
    const matches = aliasFixture();
    const canonicalTag2 = normalizeOpponentTag(ALIAS_TAGS[1]);
    const canonicalTag1 = normalizeOpponentTag(ALIAS_TAGS[0]);
    const mergingAliasMap: Record<string, string> = { [canonicalTag2]: canonicalTag1 };

    const profile = buildOpponentProfile({
      matches,
      aliasMap: mergingAliasMap,
      opponentTag: ALIAS_TAGS[0],
      refreshedAt: REFRESHED_AT,
    });

    expect(profile).not.toBeNull();
    expect(profile!.record.total).toBe(8);
    expect(profile!.recent.some((m) => m.opponent === ALIAS_TAGS[0])).toBe(true);
    expect(profile!.recent.some((m) => m.opponent === ALIAS_TAGS[1])).toBe(true);
  });
});

describe('negative control: buildStageEvidence/buildMatchupEvidence never key on match.opponent (R1-BLOCKER-2)', () => {
  it('is deep-equal for the fixture as generated and for the fixture with every match.opponent rewritten to a different string', () => {
    const original = generateSyntheticMatches({ seed: 321, count: 500 });
    const rewritten: Match[] = original.map((m, i) => ({ ...m, opponent: `rewritten-${i}` }));

    const stageOriginal = buildStageEvidence({ matches: original, refreshedAt: REFRESHED_AT });
    const stageRewritten = buildStageEvidence({ matches: rewritten, refreshedAt: REFRESHED_AT });
    expect(stageRewritten).toEqual(stageOriginal);

    const matchupOriginal = buildMatchupEvidence({ matches: original, refreshedAt: REFRESHED_AT });
    const matchupRewritten = buildMatchupEvidence({
      matches: rewritten,
      refreshedAt: REFRESHED_AT,
    });
    expect(matchupRewritten).toEqual(matchupOriginal);
  });
});
