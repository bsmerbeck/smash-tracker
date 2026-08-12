import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import resourcesToBackend from 'i18next-resources-to-backend';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';

/**
 * V15 localization. Languages follow the GA country breakdown (US/CA/UK
 * first, then the combined Spanish-speaking audience, France+Canada,
 * Germany, Brazil+Portugal, Japan) — adding another language is one JSON
 * file in ./locales, an entry here, and a loader-map entry below.
 */
export const SUPPORTED_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'pt', label: 'Português' },
  { code: 'ja', label: '日本語' },
] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]['code'];

/**
 * Non-English locales load on demand, each as its own chunk. This is an
 * explicit loader map — NOT a `import(`./locales/${language}.json`)`
 * template literal — because Vite globs a variable dynamic import over ALL
 * of ./locales/*.json including en.json, which forces en into its own
 * chunk even though the entry also imports it statically. That chunk was
 * one of the five that stalled 26–103s on a cold CDN edge in the P1
 * 2026-08-12 login incident. With en excluded here, its only importer is
 * the static import above and Rollup inlines it into the entry bundle:
 * same bytes, one fewer request, one fewer cold-edge stall opportunity.
 * Adding a language is one JSON file, one SUPPORTED_LANGUAGES entry, and
 * one loader-map entry below.
 *
 * Detection order: an explicit choice (localStorage, written by the language
 * bar) always wins; otherwise the browser's language — a better signal than
 * IP geolocation (a German speaker visiting the US still reads German) and
 * it needs no external service.
 */
const lazyLocaleLoaders: Record<string, () => Promise<{ default: object }>> = {
  es: () => import('./locales/es.json'),
  fr: () => import('./locales/fr.json'),
  de: () => import('./locales/de.json'),
  pt: () => import('./locales/pt.json'),
  ja: () => import('./locales/ja.json'),
};

i18n
  .use(LanguageDetector)
  .use(
    resourcesToBackend((language: string) => {
      // i18next requests every step of the resolution hierarchy — a
      // Brazilian browser asks for 'pt-BR', then 'pt', then 'en' — so the
      // lookup must key on the BASE code. For a code with no bundled base
      // this must REJECT (never resolve English): resolving would register
      // the English bundle under e.g. 'pt-BR', which wins resolution over
      // the correctly-loaded 'pt' bundle and silently renders the whole
      // app in English for every regional-variant browser.
      const base = language.split('-')[0] ?? language;
      if (base === 'en') return Promise.resolve(en);
      const load = lazyLocaleLoaders[base];
      return load ? load() : Promise.reject(new Error(`no bundled locale for ${language}`));
    }),
  )
  .use(initReactI18next)
  .init({
    fallbackLng: 'en',
    supportedLngs: SUPPORTED_LANGUAGES.map((l) => l.code),
    nonExplicitSupportedLngs: true,
    partialBundledLanguages: true,
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false }, // react already escapes
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
    },
    react: {
      // No Suspense: untranslated keys render the English fallback for a
      // frame instead of unmounting the tree behind a loading state.
      useSuspense: false,
    },
  });

export default i18n;
