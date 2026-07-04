import type { OpponentProfile } from '@/lib/stats';
import { getFighterById } from '@/data/sprites';
import { stagesById } from '@/data/stages';
import type { TournamentBlock } from './tournamentHistory';

/**
 * V6-W1c: "Export H2H" evidence packet — a pure content builder consumed by
 * both the print view and the "copy as text" fallback, so the two
 * presentations can never drift out of sync. Everything here is derived
 * from data the report already has in memory (no extra fetching): the
 * `OpponentProfile` (record, per-character, per-stage) plus the tournament
 * blocks already grouped for the Tournament History card.
 */

export interface TournamentEncounterLine {
  displayName: string;
  date: string;
  roundLabel: string;
  result: string;
}

export interface EvidencePacket {
  /** The tracked user's own display name/email, shown as "Prepared by". */
  preparedBy: string;
  opponent: string;
  generatedAt: number;
  record: {
    wins: number;
    losses: number;
    winRate: number;
    total: number;
  };
  dateRange: {
    firstPlayedAt: number;
    lastPlayedAt: number;
  };
  byTheirCharacter: Array<{
    name: string;
    wins: number;
    losses: number;
    winRate: number;
    total: number;
  }>;
  byStage: Array<{
    name: string;
    wins: number;
    losses: number;
    winRate: number;
    total: number;
  }>;
  tournamentEncounters: TournamentEncounterLine[];
}

/**
 * Builds the evidence packet content from an `OpponentProfile` and the
 * opponent's grouped tournament blocks. Pure — no DOM, no clipboard, no
 * printing — so it's trivially unit-testable; `preparedBy` is passed in by
 * the caller (typically the signed-in user's email) rather than looked up
 * here, keeping this function free of auth/context dependencies.
 */
export function buildEvidencePacket(
  profile: OpponentProfile,
  tournamentBlocks: TournamentBlock[],
  preparedBy: string,
  generatedAt: number = Date.now(),
): EvidencePacket {
  const byTheirCharacter = profile.byTheirFighter.map((row) => ({
    name: getFighterById(row.opponentFighterId)?.name ?? 'Unknown',
    wins: row.wins,
    losses: row.losses,
    winRate: row.ratio,
    total: row.totalMatches,
  }));

  const byStage = profile.byStage.map((row) => ({
    name: row.stageId === 0 ? 'unknown' : (stagesById.get(row.stageId)?.name ?? 'Unknown'),
    wins: row.wins,
    losses: row.losses,
    winRate: row.winRate,
    total: row.total,
  }));

  const tournamentEncounters: TournamentEncounterLine[] = tournamentBlocks.flatMap((block) =>
    block.sets.map((set) => ({
      displayName: block.displayName,
      date: new Date(set.time).toLocaleDateString(),
      roundLabel: set.roundLabel,
      result: `${set.wins}-${set.losses}${set.isLosersSide ? ' (Losers)' : ''}`,
    })),
  );

  return {
    preparedBy,
    opponent: profile.opponent,
    generatedAt,
    record: {
      wins: profile.record.wins,
      losses: profile.record.losses,
      winRate: profile.record.winRate,
      total: profile.record.total,
    },
    dateRange: {
      firstPlayedAt: profile.firstPlayedAt,
      lastPlayedAt: profile.lastPlayedAt,
    },
    byTheirCharacter,
    byStage,
    tournamentEncounters,
  };
}

function formatDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString();
}

/**
 * Renders the packet as Markdown-ish plain text — the "copy as text"
 * fallback for when printing/PDF export isn't convenient (e.g. pasting into
 * a Discord message to a teammate before a set).
 */
export function packetToText(packet: EvidencePacket): string {
  const lines: string[] = [];
  lines.push(`# H2H Evidence Packet: ${packet.preparedBy} vs ${packet.opponent}`);
  lines.push('');
  lines.push(`Generated: ${formatDate(packet.generatedAt)}`);
  lines.push(
    `Date range: ${formatDate(packet.dateRange.firstPlayedAt)} - ${formatDate(packet.dateRange.lastPlayedAt)}`,
  );
  lines.push('');
  lines.push('## Overall record');
  lines.push(
    `${packet.record.wins}-${packet.record.losses} (${packet.record.winRate}% over ${packet.record.total} game${packet.record.total === 1 ? '' : 's'})`,
  );
  lines.push('');

  lines.push('## Their characters');
  if (packet.byTheirCharacter.length === 0) {
    lines.push('No character data recorded.');
  } else {
    lines.push('| Character | Record | Win Rate | Games |');
    lines.push('| --- | --- | --- | --- |');
    for (const row of packet.byTheirCharacter) {
      lines.push(`| ${row.name} | ${row.wins}-${row.losses} | ${row.winRate}% | ${row.total} |`);
    }
  }
  lines.push('');

  lines.push('## Stages');
  if (packet.byStage.length === 0) {
    lines.push('No stage data recorded.');
  } else {
    lines.push('| Stage | Record | Win Rate |');
    lines.push('| --- | --- | --- |');
    for (const row of packet.byStage) {
      lines.push(`| ${row.name} | ${row.wins}-${row.losses} | ${row.winRate}% |`);
    }
  }
  lines.push('');

  lines.push('## Tournament encounters');
  if (packet.tournamentEncounters.length === 0) {
    lines.push('No tournament sets recorded.');
  } else {
    for (const encounter of packet.tournamentEncounters) {
      lines.push(
        `- ${encounter.date} — ${encounter.displayName} (${encounter.roundLabel}): ${encounter.result}`,
      );
    }
  }

  return lines.join('\n');
}
