import { describe, expect, it } from 'vitest';
import { SpriteList, spritesById } from './fighterData.js';
import {
  LIQUIPEDIA_CHARACTER_ALIASES,
  liquipediaCharacterToFighterId,
  normalizeLiquipediaCharacterName,
  resolveLiquipediaFighterId,
} from './liquipediaCharacterMap.js';

describe('normalizeLiquipediaCharacterName', () => {
  it('lowercases, strips diacritics, and drops punctuation/whitespace', () => {
    expect(normalizeLiquipediaCharacterName('Pokémon Trainer')).toBe('pokemontrainer');
    expect(normalizeLiquipediaCharacterName('R.O.B.')).toBe('rob');
    expect(normalizeLiquipediaCharacterName('Pyra/Mythra')).toBe('pyramythra');
    expect(normalizeLiquipediaCharacterName('Mr. Game & Watch')).toBe('mrgamewatch');
    expect(normalizeLiquipediaCharacterName('  Zero Suit Samus  ')).toBe('zerosuitsamus');
    expect(normalizeLiquipediaCharacterName('PAC-MAN')).toBe('pacman');
  });
});

describe('resolveLiquipediaFighterId — canonical names', () => {
  it('resolves EVERY member of the app fighter vocabulary to its own id', () => {
    for (const fighter of SpriteList) {
      expect(resolveLiquipediaFighterId(fighter.name), fighter.name).toBe(fighter.id);
    }
  });
});

describe('resolveLiquipediaFighterId — reviewed Liquipedia codes', () => {
  // The complete distinct code set observed in the committed bracket
  // fixtures (Supernova 2026, Full House 2025, SCU pools, SSC 2019) plus
  // their expected fighters. A code appearing in a fixture that this table
  // misses is a review gap — add it HERE and to the alias table together.
  const FIXTURE_OBSERVED: [string, string][] = [
    ['bayo', 'Bayonetta'],
    ['brawler', 'Mii Brawler'],
    ['cloud', 'Cloud'],
    ['diddy', 'Diddy Kong'],
    ['fox', 'Fox'],
    ['gw', 'Mr. Game & Watch'],
    ['hero', 'Hero'],
    ['ken', 'Ken'],
    ['mm', 'Mega Man'],
    ['ness', 'Ness'],
    ['oli', 'Olimar'],
    ['palu', 'Palutena'],
    ['pam', 'Pyra/Mythra'],
    ['rob', 'R.O.B.'],
    ['roy', 'Roy'],
    ['ryu', 'Ryu'],
    ['shulk', 'Shulk'],
    ['snake', 'Snake'],
    ['sonic', 'Sonic'],
    ['steve', 'Steve'],
    ['zelda', 'Zelda'],
    ['zss', 'Zero Suit Samus'],
  ];

  it.each(FIXTURE_OBSERVED)('maps the fixture-observed code %s to %s', (code, fighterName) => {
    const expected = SpriteList.find((fighter) => fighter.name === fighterName)!;
    expect(expected).toBeDefined();
    expect(resolveLiquipediaFighterId(code)).toBe(expected.id);
  });

  it('maps the Pokemon Trainer forms and the Pyra/Mythra halves onto their single app-vocabulary ids', () => {
    const pt = resolveLiquipediaFighterId('Pokemon Trainer');
    expect(resolveLiquipediaFighterId('squirtle')).toBe(pt);
    expect(resolveLiquipediaFighterId('ivysaur')).toBe(pt);
    expect(resolveLiquipediaFighterId('charizard')).toBe(pt);
    const pyraMythra = resolveLiquipediaFighterId('Pyra/Mythra');
    expect(resolveLiquipediaFighterId('pyra')).toBe(pyraMythra);
    expect(resolveLiquipediaFighterId('mythra')).toBe(pyraMythra);
  });

  it('distinguishes mm (Mega Man) from minmin (Min Min)', () => {
    const megaMan = SpriteList.find((fighter) => fighter.name === 'Mega Man')!;
    const minMin = SpriteList.find((fighter) => fighter.name === 'Min Min')!;
    expect(resolveLiquipediaFighterId('mm')).toBe(megaMan.id);
    expect(resolveLiquipediaFighterId('Min Min')).toBe(minMin.id);
    expect(resolveLiquipediaFighterId('minmin')).toBe(minMin.id);
  });
});

describe('resolveLiquipediaFighterId — the unmapped rule', () => {
  it.each([['Random'], ['???'], [''], ['   '], ['Marth Jr.'], ['definitely-not-a-fighter']])(
    'returns undefined for %j — an unmapped name stays raw and flagged, never guessed',
    (raw) => {
      expect(resolveLiquipediaFighterId(raw)).toBeUndefined();
    },
  );

  it('returns undefined for null/undefined input', () => {
    expect(resolveLiquipediaFighterId(null)).toBeUndefined();
    expect(resolveLiquipediaFighterId(undefined)).toBeUndefined();
  });
});

describe('alias table integrity', () => {
  it('every alias names a real fighter id and is stored pre-normalized', () => {
    for (const [alias, fighterId] of Object.entries(LIQUIPEDIA_CHARACTER_ALIASES)) {
      expect(spritesById.has(fighterId), `${alias} -> ${fighterId}`).toBe(true);
      expect(alias).toBe(normalizeLiquipediaCharacterName(alias));
    }
  });

  it('the combined lookup holds every canonical name plus every alias, with no silent overrides', () => {
    for (const fighter of SpriteList) {
      expect(
        liquipediaCharacterToFighterId.get(normalizeLiquipediaCharacterName(fighter.name)),
      ).toBe(fighter.id);
    }
    for (const [alias, fighterId] of Object.entries(LIQUIPEDIA_CHARACTER_ALIASES)) {
      expect(liquipediaCharacterToFighterId.get(alias)).toBe(fighterId);
    }
  });
});
