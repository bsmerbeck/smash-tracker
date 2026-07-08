import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import resourcesToBackend from 'i18next-resources-to-backend';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';

/**
 * V15 localization. Languages follow the GA country breakdown (US/CA/UK
 * first, then the combined Spanish-speaking audience, France+Canada,
 * Germany, Brazil+Portugal, Japan) — adding another language is one JSON
 * file in ./locales plus an entry here.
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
 * English ships in the entry bundle (it's the fallback — no async flash for
 * the default experience); every other locale loads on demand as its own
 * chunk via the dynamic import below, so 5 extra languages cost the initial
 * load nothing.
 *
 * Detection order: an explicit choice (localStorage, written by the language
 * bar) always wins; otherwise the browser's language — a better signal than
 * IP geolocation (a German speaker visiting the US still reads German) and
 * it needs no external service.
 */
i18n
  .use(LanguageDetector)
  .use(
    resourcesToBackend((language: string) =>
      language === 'en' ? Promise.resolve(en) : import(`./locales/${language}.json`),
    ),
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
