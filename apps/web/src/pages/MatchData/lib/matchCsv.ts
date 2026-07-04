import type { Match } from '@smash-tracker/shared';
import { getFighterById } from '@/data/sprites';
import { tournamentLabel } from './matchTableFilters';

/** Column headers, in export order — includes every field a user could want offline, notes and tournament included. */
const CSV_HEADERS = [
  'Date',
  'Fighter',
  'Opponent Fighter',
  'Opponent Name',
  'Stage',
  'Type',
  'Result',
  'Tournament',
  'Notes',
] as const;

/**
 * Quotes a single CSV field per RFC 4180: wraps in double quotes and doubles
 * any embedded quote whenever the value contains a comma, quote, or newline.
 * Values that need no special handling are returned unquoted for readability.
 */
export function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function matchToCsvRow(match: Match): string[] {
  const fighter = getFighterById(match.fighter_id);
  const opponentFighter = getFighterById(match.opponent_id);
  const tournament = tournamentLabel(match);

  return [
    new Date(match.time).toLocaleString(),
    fighter?.name ?? 'Unknown',
    opponentFighter?.name ?? 'Unknown',
    match.opponent ?? '',
    match.map?.name ?? 'unknown',
    match.matchType ?? '',
    match.win ? 'Win' : 'Loss',
    tournament,
    match.notes ?? '',
  ];
}

/**
 * Builds a CSV string (CRLF line endings per RFC 4180) for the given matches
 * — callers pass the currently-filtered row set so the export matches what's
 * on screen. Pure/no I/O so it's independently testable; the caller wraps
 * the result in a Blob for download.
 */
export function buildMatchCsv(matches: Match[]): string {
  const lines = [CSV_HEADERS.join(',')];
  for (const match of matches) {
    lines.push(matchToCsvRow(match).map(csvField).join(','));
  }
  return lines.join('\r\n');
}

/** `smash-tracker-matches-YYYYMMDD.csv` using the given date (defaults to now), local time. */
export function matchCsvFilename(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `smash-tracker-matches-${y}${m}${d}.csv`;
}
