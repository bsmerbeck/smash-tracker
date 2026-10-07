import { describe, expect, it } from 'vitest';
import en from './locales/en.json';
import es from './locales/es.json';
import fr from './locales/fr.json';
import de from './locales/de.json';
import pt from './locales/pt.json';
import ja from './locales/ja.json';

/**
 * 39.2-REVIEW WEB-IN (seed-delta copy): the Tournaments table's seed-delta header and its
 * screen-reader sentence were English ("Seed Δ", "Seed {{seed}} → {{placement}}") in es/fr/de/pt.
 * Each locale must speak its own seed term — the one its `seedToFinish` string already uses —
 * and keep both placeholders.
 */
const LOCALES = { es, fr, de, pt, ja } as const;

describe('seed-delta copy is translated in every non-English locale', () => {
  it.each(Object.entries(LOCALES))('%s', (_code, locale) => {
    const table = locale.tournaments.table;
    expect(table.seedDelta).not.toBe(en.tournaments.table.seedDelta);
    expect(table.seedDeltaAria).not.toBe(en.tournaments.table.seedDeltaAria);
    expect(table.seedDeltaAria).not.toMatch(/\bSeed\b/);
    expect(table.seedDeltaAria).toContain('{{seed}}');
    expect(table.seedDeltaAria).toContain('{{placement}}');
  });
});
