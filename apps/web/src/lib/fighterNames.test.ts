import { describe, expect, it } from 'vitest';
import { SpriteList } from '@smash-tracker/shared';
import i18n from '@/i18n';
import en from '@/i18n/locales/en.json';
import es from '@/i18n/locales/es.json';
import fr from '@/i18n/locales/fr.json';
import de from '@/i18n/locales/de.json';
import pt from '@/i18n/locales/pt.json';
import ja from '@/i18n/locales/ja.json';
import { foldDiacritics, localizedFighterName, matchesFighterQuery } from './fighterNames';

const LOCALES = { en, es, fr, de, pt, ja } as const;

/**
 * Synchronously injects each non-en locale bundle into the shared i18next
 * instance (mirrors the dynamic-import loading `@/i18n/index.ts` does at
 * runtime) so `i18n.getFixedT(code)` returns a locale-bound `t` without
 * mutating the active language (unlike `changeLanguage`).
 */
for (const [code, bundle] of Object.entries(LOCALES)) {
  if (code === 'en') continue;
  i18n.addResourceBundle(code, 'translation', bundle, true, true);
}

function fixedT(code: string) {
  return i18n.getFixedT(code);
}

describe('fighterNames data completeness', () => {
  const spriteIds = SpriteList.map((s) => String(s.id)).sort((a, b) => Number(a) - Number(b));

  for (const [code, bundle] of Object.entries(LOCALES)) {
    it(`${code} fighterNames covers every SpriteList id with no extras`, () => {
      const keys = Object.keys(bundle.fighterNames).sort((a, b) => Number(a) - Number(b));
      expect(keys).toEqual(spriteIds);
    });
  }

  it('en fighterNames values strictly equal the SpriteList canonical name for every id', () => {
    for (const sprite of SpriteList) {
      expect(en.fighterNames[String(sprite.id) as keyof typeof en.fighterNames]).toBe(sprite.name);
    }
  });
});

describe('localizedFighterName', () => {
  it('resolves the localized name for es/fr/de/ja bundles', () => {
    expect(localizedFighterName(51, fixedT('es'))).toBe('Estela y Destello');
    expect(localizedFighterName(13, fixedT('fr'))).toBe('Rondoudou');
    expect(localizedFighterName(13, fixedT('de'))).toBe('Pummeluff');
    expect(localizedFighterName(1, fixedT('ja'))).toBe('マリオ');
  });

  it('falls back to the canonical English SpriteList name for pt (documented fallback)', () => {
    expect(localizedFighterName(13, fixedT('pt'))).toBe('Jigglypuff');
    expect(localizedFighterName(62, fixedT('pt'))).toBe('Duck hunt');
  });

  it('falls back to the canonical English name when an id is missing from a bundle', () => {
    expect(localizedFighterName(9999, fixedT('fr'))).toBe('');
  });
});

describe('foldDiacritics', () => {
  it('strips diacritics and is idempotent / lower-case-safe', () => {
    expect(foldDiacritics('Héroe')).toBe('Heroe');
    expect(foldDiacritics('héroe')).toBe('heroe');
    expect(foldDiacritics(foldDiacritics('Héroe'))).toBe('Heroe');
  });
});

describe('matchesFighterQuery', () => {
  it('matches a prefix of the localized name (fr Rondoudou)', () => {
    expect(matchesFighterQuery('rond', 'Rondoudou', 'Jigglypuff')).toBe(true);
  });

  it('matches a prefix of the English name even when localized differs (fr Jigglypuff)', () => {
    expect(matchesFighterQuery('jigg', 'Rondoudou', 'Jigglypuff')).toBe(true);
  });

  it('matches diacritics-insensitively against the localized name (es Héroe)', () => {
    expect(matchesFighterQuery('hero', 'Héroe', 'Hero')).toBe(true);
    expect(matchesFighterQuery('héroe', 'Héroe', 'Hero')).toBe(true);
  });

  it('is false when the query matches neither name', () => {
    expect(matchesFighterQuery('zzz', 'Rondoudou', 'Jigglypuff')).toBe(false);
  });

  it('matches everything for an empty query', () => {
    expect(matchesFighterQuery('', 'Rondoudou', 'Jigglypuff')).toBe(true);
  });
});
