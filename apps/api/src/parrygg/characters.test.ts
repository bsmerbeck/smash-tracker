import { describe, expect, it } from 'vitest';
import { parryggCharacterSlugToFighterId } from './characters.js';

describe('parryggCharacterSlugToFighterId', () => {
  it('resolves common slugs directly via name normalization', () => {
    expect(parryggCharacterSlugToFighterId('mario')).toBe(1);
    expect(parryggCharacterSlugToFighterId('captain-falcon')).toBe(12);
    expect(parryggCharacterSlugToFighterId('r-o-b')).toBe(45);
    expect(parryggCharacterSlugToFighterId('mr-game-and-watch')).toBe(30);
  });

  it('is case/dash/underscore-insensitive', () => {
    expect(parryggCharacterSlugToFighterId('CAPTAIN_FALCON')).toBe(12);
    expect(parryggCharacterSlugToFighterId('Captain Falcon')).toBe(12);
  });

  it('applies the curated overrides table', () => {
    expect(parryggCharacterSlugToFighterId('rosalina')).toBe(51); // -> Rosalina & Luma
    expect(parryggCharacterSlugToFighterId('simon-belmont')).toBe(70); // -> Simon
    expect(parryggCharacterSlugToFighterId('pyra')).toBe(84);
    expect(parryggCharacterSlugToFighterId('mythra')).toBe(84);
    expect(parryggCharacterSlugToFighterId('banjo-kazooie')).toBe(78);
    expect(parryggCharacterSlugToFighterId('game-and-watch')).toBe(30);
    expect(parryggCharacterSlugToFighterId('king-koopa')).toBe(16);
  });

  it('returns undefined for unmapped/missing slugs', () => {
    expect(parryggCharacterSlugToFighterId('totally-unknown-character')).toBeUndefined();
    expect(parryggCharacterSlugToFighterId(null)).toBeUndefined();
    expect(parryggCharacterSlugToFighterId(undefined)).toBeUndefined();
    expect(parryggCharacterSlugToFighterId('')).toBeUndefined();
  });
});
