import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import i18next from 'i18next';
import en from './locales/en.json';
import es from './locales/es.json';
import fr from './locales/fr.json';
import de from './locales/de.json';
import pt from './locales/pt.json';
import ja from './locales/ja.json';

/**
 * 39.1-REVIEW (iteration 2) WR-01: renaming `analytics.strip.aria` to an
 * `aria_one`/`aria_other` pair that interpolates `{{shown}}` left one caller
 * passing only `{ count }`, so i18next rendered a literal `{{shown}}` into a
 * screen-reader name. The locale-consistency tests could not see it: they
 * compare locale files, never a call site's variables against a key's
 * placeholders.
 *
 * This is the repo-wide oracle. It finds EVERY `t('analytics.strip.aria', …)`
 * call in the web source, reads the variable names that call passes, and
 * renders the key with exactly those variables in all 6 locales (both plural
 * forms). A rendered name containing `{{` means a caller is missing a
 * variable the key needs.
 */

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STRIP_ARIA_CALL = /\bt\(\s*(['"`])analytics\.strip\.aria\1\s*/g;
const LOCALES = { en, es, fr, de, pt, ja } as const;

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'locales' ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

/** The `{ … }` options object text starting at `from`, or null when the call passes none. */
function optionsObjectAt(source: string, from: number): string | null {
  if (source[from] !== ',') return null;
  const open = source.indexOf('{', from);
  const close = source.indexOf(')', from);
  if (open === -1 || (close !== -1 && close < open)) return null;
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') depth -= 1;
    if (depth === 0) return source.slice(open + 1, i);
  }
  return null;
}

/** Top-level property names of an object literal body (`a: x, b` -> ['a', 'b']). */
function propertyNames(body: string): string[] {
  const names: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of body) {
    if ('{(['.includes(char)) depth += 1;
    if ('})]'.includes(char)) depth -= 1;
    if (char === ',' && depth === 0) {
      names.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  names.push(current);
  return names
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => (part.split(':')[0] ?? part).trim());
}

interface StripAriaCaller {
  site: string;
  variables: string[];
}

function stripAriaCallers(): StripAriaCaller[] {
  return sourceFiles(SRC_DIR).flatMap((file) => {
    const source = fs.readFileSync(file, 'utf8');
    return Array.from(source.matchAll(STRIP_ARIA_CALL)).map((match) => {
      const after = (match.index ?? 0) + match[0].length;
      const line = source.slice(0, match.index).split('\n').length;
      const body = optionsObjectAt(source, after);
      return {
        site: `${path.relative(SRC_DIR, file)}:${line}`,
        variables: body === null ? [] : propertyNames(body),
      };
    });
  });
}

function fixedT(locale: keyof typeof LOCALES) {
  const instance = i18next.createInstance();
  void instance.init({
    lng: locale,
    fallbackLng: 'en',
    initAsync: false,
    resources: { [locale]: { translation: LOCALES[locale] }, en: { translation: en } },
    interpolation: { escapeValue: false },
  });
  return instance.getFixedT(locale);
}

describe('every analytics.strip.aria caller renders a complete accessible name (WR-01)', () => {
  const callers = stripAriaCallers();

  it('finds the strip aria callers (non-vacuity: the three FormStrip hosts and the Matchups mini strip)', () => {
    expect(callers.map((caller) => caller.site).sort()).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/MatchWinLossCard\.tsx:/),
        expect.stringMatching(/MatchupChart\.tsx:/),
        expect.stringMatching(/FighterHero\.tsx:/),
        expect.stringMatching(/OpponentHubPage\.tsx:/),
      ]),
    );
  });

  it.each(Object.keys(LOCALES) as (keyof typeof LOCALES)[])(
    'no caller leaves a {{placeholder}} in the rendered name (%s, both plural forms)',
    (locale) => {
      const t = fixedT(locale);
      for (const caller of callers) {
        for (const count of [1, 7]) {
          const vars = Object.fromEntries(caller.variables.map((name) => [name, count]));
          const rendered = t('analytics.strip.aria', vars);
          expect(rendered, `${caller.site} (${locale}, count=${count})`).not.toMatch(/\{\{/);
          expect(rendered, `${caller.site} (${locale}) resolved the key`).not.toBe(
            'analytics.strip.aria',
          );
        }
      }
    },
  );
});
