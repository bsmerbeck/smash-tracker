import { afterEach, describe, expect, it } from 'vitest';
import i18n, { SUPPORTED_LANGUAGES } from '@/i18n';
import en from './locales/en.json';

/** Every leaf key path in a (nested) translation object. */
function keyPaths(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === 'object' && value !== null
      ? keyPaths(value as Record<string, unknown>, path)
      : [path];
  });
}

describe('i18n', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('every supported locale covers exactly the English key set', async () => {
    const enKeys = keyPaths(en).sort();
    for (const { code } of SUPPORTED_LANGUAGES) {
      if (code === 'en') continue;
      const mod = (await import(`./locales/${code}.json`)) as { default: Record<string, unknown> };
      expect(keyPaths(mod.default).sort(), `locale ${code}`).toEqual(enKeys);
    }
  });

  it('switching language translates and switching back restores English', async () => {
    expect(i18n.t('nav.dashboard')).toBe('Dashboard');

    await i18n.changeLanguage('es');
    expect(i18n.t('nav.dashboard')).toBe('Panel');
    expect(i18n.t('chrome.languageChanged', { language: 'Español' })).toContain('Español');

    await i18n.changeLanguage('en');
    expect(i18n.t('nav.dashboard')).toBe('Dashboard');
  });

  it('falls back to English for unsupported languages', async () => {
    await i18n.changeLanguage('xx');
    expect(i18n.t('nav.dashboard')).toBe('Dashboard');
  });
});
