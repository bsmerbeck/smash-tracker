import { afterEach, describe, expect, it } from 'vitest';
import i18n, { SUPPORTED_LANGUAGES } from '@/i18n';
import en from './locales/en.json';
import es from './locales/es.json';
import fr from './locales/fr.json';
import de from './locales/de.json';
import pt from './locales/pt.json';
import ja from './locales/ja.json';

/** Every leaf key path in a (nested) translation object. */
function keyPaths(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === 'object' && value !== null
      ? keyPaths(value as Record<string, unknown>, path)
      : [path];
  });
}

/** Every [leaf key path, string value] pair in a (nested) translation object. */
function keyPathValues(obj: Record<string, unknown>, prefix = ''): [string, string][] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === 'object' && value !== null
      ? keyPathValues(value as Record<string, unknown>, path)
      : ([[path, String(value)]] as [string, string][]);
  });
}

/** Reads a dotted key path (e.g. "binding.error.notFound") off a nested object. */
function getByPath(obj: Record<string, unknown>, path: string): string {
  const value = path
    .split('.')
    .reduce<unknown>((node, segment) => (node as Record<string, unknown>)[segment], obj);
  return String(value);
}

/** The set of {{token}} names an i18next interpolation string references. */
function interpolationTokens(value: string): string[] {
  return [...value.matchAll(/\{\{(\w+)\}\}/g)]
    .map((m) => m[1])
    .filter((token): token is string => token !== undefined)
    .sort();
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

  /**
   * P1 2026-08-12 regression lock: real browsers report regional variants
   * ('pt-BR', 'es-419'), and i18next requests every hierarchy step from the
   * backend ('pt-BR' → 'pt' → 'en'). The locale loader must serve the BASE
   * bundle for a variant request and REJECT for codes it has no bundle for —
   * a fallback that resolved English registered the English bundle UNDER
   * 'pt-BR', which won resolution over the correctly-loaded 'pt' bundle and
   * silently rendered the entire app in English for variant browsers.
   */
  it('regional variants render their base language, not English', async () => {
    await i18n.changeLanguage('pt-BR');
    expect(i18n.t('nav.dashboard')).toBe(getByPath(pt, 'nav.dashboard'));
    expect(i18n.t('nav.dashboard')).not.toBe('Dashboard');

    await i18n.changeLanguage('es-419');
    expect(i18n.t('nav.dashboard')).toBe(getByPath(es, 'nav.dashboard'));
  });
});

/**
 * Phase 27 (27-03-PLAN.md Task 2). Locks two things machine-enforced from
 * here on:
 *  - the new prepPaid.* namespace's cross-locale key/interpolation/plural
 *    parity, so 27-10's PrepPaidReportsCard never ships with a missing
 *    translation or a dropped {{token}};
 *  - the Phase 26 prep.* namespace's continued monetization-free status,
 *    now checked across all six locales (prepStructuralIntegrity.test.ts's
 *    equivalent case only ever checked en).
 */
describe('prepPaid namespace (Phase 27)', () => {
  const NON_EN_LOCALES = { es, fr, de, pt, ja } as const;
  const ALL_LOCALES = { en, es, fr, de, pt, ja } as const;

  // Same regex prepStructuralIntegrity.test.ts (Phase 26, RPT-04) greps the
  // `prep` namespace with — duplicated here (not imported cross-directory)
  // so this Phase 27 gate can widen the check to all six locales.
  const MONETIZATION_VOCABULARY =
    /upgrade|unlock|paywall|pricing|price|checkout|stripe|coming soon|\$\d/i;

  const UNTRANSLATED_LITERALS = ['start.gg', 'parry.gg', 'grandfinals.gg'];

  it('exists in every locale', () => {
    for (const [code, bundle] of Object.entries(ALL_LOCALES)) {
      expect(bundle.prepPaid, `locale ${code}`).toBeTruthy();
    }
  });

  it('has identical flattened key sets across all six locales', () => {
    const enKeys = keyPaths(en.prepPaid).sort();
    for (const [code, bundle] of Object.entries(NON_EN_LOCALES)) {
      const keys = keyPaths(bundle.prepPaid).sort();
      const missing = enKeys.filter((k) => !keys.includes(k));
      const extra = keys.filter((k) => !enKeys.includes(k));
      expect(
        keys,
        `locale ${code} prepPaid key mismatch — missing: [${missing.join(', ')}], extra: [${extra.join(', ')}]`,
      ).toEqual(enKeys);
    }
  });

  it('keeps every {{interpolation}} token identical across locales', () => {
    const enLeaves = keyPathValues(en.prepPaid);
    for (const [code, bundle] of Object.entries(NON_EN_LOCALES)) {
      for (const [path, enValue] of enLeaves) {
        const enTokens = interpolationTokens(enValue);
        const locTokens = interpolationTokens(getByPath(bundle.prepPaid, path));
        expect(locTokens, `locale ${code} prepPaid.${path} interpolation tokens`).toEqual(enTokens);
      }
    }
  });

  it('uses the house _one/_other plural convention for every count-bearing key', () => {
    const enLeaves = keyPathValues(en.prepPaid);

    const countBearingSingulars = enLeaves.filter(
      ([path, value]) =>
        !path.endsWith('_one') && !path.endsWith('_other') && /\{\{count\}\}/.test(value),
    );
    expect(
      countBearingSingulars.map(([path]) => path),
      'keys whose value interpolates {{count}} must be split into a _one/_other pair',
    ).toEqual([]);

    const pluralBases = new Set(
      enLeaves
        .filter(([path]) => path.endsWith('_one') || path.endsWith('_other'))
        .map(([path]) => path.replace(/_(one|other)$/, '')),
    );
    const bareSingularForms = [...pluralBases].filter((base) =>
      enLeaves.some(([path]) => path === base),
    );
    expect(
      bareSingularForms,
      'a bare (non-suffixed) key must not exist alongside its _one/_other pair',
    ).toEqual([]);
  });

  it('keeps the Phase 26 prep namespace free of monetization vocabulary', () => {
    for (const [code, bundle] of Object.entries(ALL_LOCALES)) {
      expect(JSON.stringify(bundle.prep), `locale ${code}`).not.toMatch(MONETIZATION_VOCABULARY);
    }
  });

  it('keeps provider and product names untranslated', () => {
    const enLeaves = keyPathValues(en.prepPaid);
    for (const [path, enValue] of enLeaves) {
      const literalsInValue = UNTRANSLATED_LITERALS.filter((literal) => enValue.includes(literal));
      if (literalsInValue.length === 0) continue;

      for (const [code, bundle] of Object.entries(NON_EN_LOCALES)) {
        const locValue = getByPath(bundle.prepPaid, path);
        for (const literal of literalsInValue) {
          expect(
            locValue.includes(literal),
            `locale ${code} prepPaid.${path} must keep "${literal}" untranslated (got: "${locValue}")`,
          ).toBe(true);
        }
      }
    }
  });
});
