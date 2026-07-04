import { describe, expect, it } from 'vitest';
import type { Match } from '@smash-tracker/shared';
import { SpriteList } from '@/data/sprites';
import { buildMatchCsv, csvField, matchCsvFilename } from './matchCsv';

const mario = SpriteList.find((s) => s.id === 1)!;
const luigi = SpriteList.find((s) => s.id === 10)!;

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    id: 'm1',
    fighter_id: mario.id,
    opponent_id: luigi.id,
    time: 1_700_000_000_000,
    map: { id: 0, name: 'no selection' },
    opponent: 'rival',
    notes: 'gg',
    matchType: 'none',
    win: true,
    ...overrides,
  };
}

describe('csvField', () => {
  it('returns plain values unquoted', () => {
    expect(csvField('Battlefield')).toBe('Battlefield');
  });

  it('quotes and escapes a value containing a comma', () => {
    expect(csvField('gg, well played')).toBe('"gg, well played"');
  });

  it('quotes and doubles embedded quotes', () => {
    expect(csvField('he said "gg"')).toBe('"he said ""gg"""');
  });

  it('quotes a value containing a newline', () => {
    expect(csvField('line one\nline two')).toBe('"line one\nline two"');
  });

  it('quotes a value containing a carriage return', () => {
    expect(csvField('line one\rline two')).toBe('"line one\rline two"');
  });

  it('leaves an empty string unquoted', () => {
    expect(csvField('')).toBe('');
  });
});

describe('buildMatchCsv', () => {
  it('includes a header row with every column, including tournament and notes', () => {
    const csv = buildMatchCsv([]);
    expect(csv).toBe(
      'Date,Fighter,Opponent Fighter,Opponent Name,Stage,Type,Result,Tournament,Notes',
    );
  });

  it('renders a manual match row with a "—" tournament fallback', () => {
    const csv = buildMatchCsv([makeMatch()]);
    const [, row] = csv.split('\r\n');
    expect(row).toContain(`${mario.name},${luigi.name},rival,no selection,none,Win,—,gg`);
  });

  it('prefers tournamentName over eventName, and falls back through both', () => {
    const withTournament = buildMatchCsv([
      makeMatch({ tournamentName: 'The Big House 9', eventName: 'Ultimate Singles' }),
    ]);
    expect(withTournament.split('\r\n')[1]).toContain('The Big House 9');

    const eventOnly = buildMatchCsv([makeMatch({ eventName: 'Ultimate Singles' })]);
    expect(eventOnly.split('\r\n')[1]).toContain('Ultimate Singles');
  });

  it('quotes notes containing commas, quotes, and newlines', () => {
    const csv = buildMatchCsv([makeMatch({ notes: 'close game, "clutch" win\nrematch soon' })]);
    const row = csv.split('\r\n')[1];
    expect(row).toContain('"close game, ""clutch"" win\nrematch soon"');
  });

  it('joins multiple rows with CRLF', () => {
    const csv = buildMatchCsv([makeMatch({ id: 'm1' }), makeMatch({ id: 'm2', win: false })]);
    expect(csv.split('\r\n')).toHaveLength(3); // header + 2 rows
  });

  it('falls back to "Unknown" for unrecognized fighter ids', () => {
    const csv = buildMatchCsv([makeMatch({ fighter_id: 999999 })]);
    expect(csv.split('\r\n')[1]).toContain('Unknown');
  });
});

describe('matchCsvFilename', () => {
  it('formats as smash-tracker-matches-YYYYMMDD.csv', () => {
    expect(matchCsvFilename(new Date(2026, 6, 3))).toBe('smash-tracker-matches-20260703.csv');
  });

  it('zero-pads single-digit months and days', () => {
    expect(matchCsvFilename(new Date(2026, 0, 5))).toBe('smash-tracker-matches-20260105.csv');
  });
});
