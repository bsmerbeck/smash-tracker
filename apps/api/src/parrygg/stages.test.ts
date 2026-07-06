import { describe, expect, it } from 'vitest';
import { resolveParryggStage } from './stages.js';

describe('resolveParryggStage', () => {
  it('resolves common slugs directly via name normalization', () => {
    expect(resolveParryggStage('battlefield')).toMatchObject({ name: 'Battlefield' });
    expect(resolveParryggStage('final-destination')).toMatchObject({ name: 'Final Destination' });
    expect(resolveParryggStage('small-battlefield')).toMatchObject({ name: 'Small Battlefield' });
  });

  it('normalizes accents and apostrophes onto the app stage list', () => {
    expect(resolveParryggStage('pokemon-stadium-2')).toMatchObject({ name: 'Pokémon Stadium 2' });
    expect(resolveParryggStage('yoshis-island')).toMatchObject({ name: 'Yoshi’s Island' });
  });

  it('returns null for unmapped/missing slugs', () => {
    expect(resolveParryggStage('some-brand-new-stage')).toBeNull();
    expect(resolveParryggStage(null)).toBeNull();
    expect(resolveParryggStage(undefined)).toBeNull();
    expect(resolveParryggStage('')).toBeNull();
  });
});
