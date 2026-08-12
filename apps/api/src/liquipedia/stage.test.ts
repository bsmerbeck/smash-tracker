import { describe, expect, it } from 'vitest';
import { canonicalizeLiquipediaStage, LIQUIPEDIA_STAGE_FORM_PREFIXES } from './stage.js';

const ULTIMATE = { sourceGame: 'ultimate', targetGame: 'ultimate' } as const;

describe('LIQUIPEDIA_STAGE_FORM_PREFIXES', () => {
  it('declares exactly the three observed prefixes', () => {
    const forms = LIQUIPEDIA_STAGE_FORM_PREFIXES.map((p) => p.form);
    expect(forms).toEqual(['hazardless', 'omega', 'battlefield']);
  });
});

describe('canonicalizeLiquipediaStage — stage-form prefixes', () => {
  it('the hazardless (Φ) prefix yields the hazardless form with the prefix removed from the base name', () => {
    const result = canonicalizeLiquipediaStage('Φ Town and City', ULTIMATE);
    expect(result.stageForm).toBe('hazardless');
    expect(result.baseName).toBe('Town and City');
    expect(result.canonicalStageId).toBe(85);
    expect(result.canonicalStageName).toBe('Town and City');
  });

  it('the omega (Ω) prefix yields the omega form with the prefix removed from the base name', () => {
    const result = canonicalizeLiquipediaStage('Ω Town and City', ULTIMATE);
    expect(result.stageForm).toBe('omega');
    expect(result.baseName).toBe('Town and City');
  });

  it("the battlefield ('B ') prefix yields the battlefield form with the prefix removed from the base name", () => {
    const result = canonicalizeLiquipediaStage('B Town and City', ULTIMATE);
    expect(result.stageForm).toBe('battlefield');
    expect(result.baseName).toBe('Town and City');
  });

  it('a bare stage name with no prefix yields the normal form (UNSTATED, not an assertion of hazards-on)', () => {
    const result = canonicalizeLiquipediaStage('Battlefield', ULTIMATE);
    expect(result.stageForm).toBe('normal');
    expect(result.baseName).toBe('Battlefield');
    expect(result.canonicalStageId).toBe(1);
  });

  it('the prefix is extracted by code point — both multi-byte prefixes (Φ, Ω) behave identically to the ASCII one', () => {
    const hazardless = canonicalizeLiquipediaStage('Φ Smashville', ULTIMATE);
    const omega = canonicalizeLiquipediaStage('Ω Smashville', ULTIMATE);
    const battlefield = canonicalizeLiquipediaStage('B Smashville', ULTIMATE);
    expect(hazardless.baseName).toBe('Smashville');
    expect(omega.baseName).toBe('Smashville');
    expect(battlefield.baseName).toBe('Smashville');
    expect([...hazardless.baseName]).toEqual([...battlefield.baseName]);
  });

  it('an unrecognised leading symbol yields the unknown form, a null canonical id, and a review flag set', () => {
    const result = canonicalizeLiquipediaStage('★ Battlefield', ULTIMATE);
    expect(result.stageForm).toBe('unknown');
    expect(result.canonicalStageId).toBeNull();
    expect(result.needsReview).toBe(true);
    expect(result.reason).not.toBeNull();
  });

  it('never strips the unrecognised symbol from the raw string', () => {
    const raw = '★ Battlefield';
    const result = canonicalizeLiquipediaStage(raw, ULTIMATE);
    expect(result.rawStage).toBe(raw);
  });
});

describe('canonicalizeLiquipediaStage — apostrophe normalization (the U+2019 trap)', () => {
  it('an ASCII-apostrophe stage name maps to the canonical entry stored with a typographic apostrophe', () => {
    const result = canonicalizeLiquipediaStage("Yoshi's Island", ULTIMATE);
    expect(result.canonicalStageId).toBe(35);
    expect(result.canonicalStageName).toBe('Yoshi’s Island');
  });
});

describe('canonicalizeLiquipediaStage — counterpick suffix stripping', () => {
  it('strips a "(CP)" counterpick suffix from a tournament ruleset stage list before lookup', () => {
    const result = canonicalizeLiquipediaStage('Φ Kalos Pokémon League (CP)', ULTIMATE);
    expect(result.baseName).toBe('Kalos Pokémon League');
    expect(result.stageForm).toBe('hazardless');
    expect(result.canonicalStageId).toBe(63);
    expect(result.canonicalStageName).toBe('Kalos Pokémon League');
  });
});

describe('canonicalizeLiquipediaStage — no fuzzy matching, ever', () => {
  it('a stage name absent from the app list yields a null canonical id with the raw string preserved, never fuzzy-matched', () => {
    const raw = 'Kongo Jungle (64)';
    const result = canonicalizeLiquipediaStage(raw, ULTIMATE);
    expect(result.rawStage).toBe(raw);
    expect(result.canonicalStageId).toBeNull();
    expect(result.needsReview).toBe(true);
    // Must NOT have been silently mapped onto the similarly-named "Kongo Jungle".
    expect(result.canonicalStageName).toBeNull();
  });
});

describe('canonicalizeLiquipediaStage — game-scope guard', () => {
  it('rejects canonical mapping when the source page declared a different game than the target, even though the raw name exists in the app list', () => {
    const result = canonicalizeLiquipediaStage('Pokémon Stadium', {
      sourceGame: 'melee',
      targetGame: 'ultimate',
    });
    expect(result.canonicalStageId).toBeNull();
    expect(result.reason).toMatch(/melee/i);
    expect(result.reason).toMatch(/ultimate/i);
  });

  it('maps normally when the source game matches the target game', () => {
    const result = canonicalizeLiquipediaStage('Pokémon Stadium', ULTIMATE);
    expect(result.canonicalStageId).toBe(58);
  });

  it('maps normally when the source page states no game at all (sourceGame: null)', () => {
    const result = canonicalizeLiquipediaStage('Battlefield', {
      sourceGame: null,
      targetGame: 'ultimate',
    });
    expect(result.canonicalStageId).toBe(1);
  });
});

describe('canonicalizeLiquipediaStage — raw preservation', () => {
  it('every result carries the raw source string byte-identical to the input', () => {
    const inputs = [
      'Φ Town and City',
      'B Battlefield',
      "Yoshi's Island",
      'Ω Smashville (CP)',
      '★ Wobbuffet Arena',
    ];
    for (const raw of inputs) {
      expect(canonicalizeLiquipediaStage(raw, ULTIMATE).rawStage).toBe(raw);
    }
  });
});

describe('canonicalizeLiquipediaStage — the mandatory Supernova fixture stage vocabulary', () => {
  // The eight distinct raw stage values that appear in the mandatory
  // Supernova 2026 fixture (RESEARCH section 4.4), including all four
  // hazardless ones.
  const cases: Array<{
    raw: string;
    form: 'normal' | 'hazardless';
    canonicalStageId: number;
    canonicalStageName: string;
  }> = [
    {
      raw: 'Small Battlefield',
      form: 'normal',
      canonicalStageId: 113,
      canonicalStageName: 'Small Battlefield',
    },
    {
      raw: 'Φ Pokémon Stadium 2',
      form: 'hazardless',
      canonicalStageId: 59,
      canonicalStageName: 'Pokémon Stadium 2',
    },
    { raw: 'Battlefield', form: 'normal', canonicalStageId: 1, canonicalStageName: 'Battlefield' },
    {
      raw: 'Final Destination',
      form: 'normal',
      canonicalStageId: 3,
      canonicalStageName: 'Final Destination',
    },
    {
      raw: 'Φ Town and City',
      form: 'hazardless',
      canonicalStageId: 85,
      canonicalStageName: 'Town and City',
    },
    {
      raw: 'Hollow Bastion',
      form: 'normal',
      canonicalStageId: 118,
      canonicalStageName: 'Hollow Bastion',
    },
    {
      raw: 'Φ Kalos Pokémon League',
      form: 'hazardless',
      canonicalStageId: 63,
      canonicalStageName: 'Kalos Pokémon League',
    },
    {
      raw: 'Φ Smashville',
      form: 'hazardless',
      canonicalStageId: 83,
      canonicalStageName: 'Smashville',
    },
  ];

  it.each(cases)(
    '$raw -> form=$form, id=$canonicalStageId',
    ({ raw, form, canonicalStageId, canonicalStageName }) => {
      const result = canonicalizeLiquipediaStage(raw, ULTIMATE);
      expect(result.stageForm).toBe(form);
      expect(result.canonicalStageId).toBe(canonicalStageId);
      expect(result.canonicalStageName).toBe(canonicalStageName);
      expect(result.needsReview).toBe(false);
    },
  );
});
