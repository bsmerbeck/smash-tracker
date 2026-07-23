import { describe, expect, it } from 'vitest';
import { SpriteList } from '@smash-tracker/shared';
import en from '@/i18n/locales/en.json';
import es from '@/i18n/locales/es.json';
import fr from '@/i18n/locales/fr.json';
import de from '@/i18n/locales/de.json';
import pt from '@/i18n/locales/pt.json';
import ja from '@/i18n/locales/ja.json';

const LOCALES = { en, es, fr, de, pt, ja } as const;

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
