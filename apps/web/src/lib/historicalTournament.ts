import { z } from 'zod';
import { tournamentEntrySchema, type TournamentEntry } from '@smash-tracker/shared';

/**
 * Phase 30.3 (owner corrective directive, Gate 4): web-local mirror of the
 * admin-imported historical tournament contract the API's
 * GET /api/tournaments rows may now carry. Defined HERE (not in
 * packages/shared) because this gate owns apps/web/** only — the lead swaps
 * these to the shared import at integration once the server-side schema
 * lands. Every added field is `.nullish()` (and the discriminators are plain
 * strings, narrowed by `isAdminImportedEntry` below, never `z.literal`) so a
 * registry that predates the import — or carries a future origin value this
 * build doesn't know — still parses instead of failing the whole list.
 */
export const historicalProvenanceSchema = z.object({
  /** Import pipeline identifier — 'research-import' for the demo-history drive. */
  source: z.string().min(1),
  /** Epoch ms the row was written by the import. */
  importedAtMs: z.number().int().nonnegative(),
  /** Epoch ms the researched public data was current as of, when recorded. */
  asOfMs: z.number().int().nonnegative().nullish(),
});
export type HistoricalProvenance = z.infer<typeof historicalProvenanceSchema>;

export const historicalTournamentEntrySchema = tournamentEntrySchema.extend({
  /** Row-origin discriminator; 'admin-imported' marks research-imported history. */
  origin: z.string().min(1).nullish(),
  /** Source site of the imported public data — 'startgg' for this drive. */
  provider: z.string().min(1).nullish(),
  /** start.gg event id as carried by the import (parallel to the legacy `eventId`). */
  startggEventId: z.number().int().positive().nullish(),
  /** Tournament-level path slug as carried by the import (parallel to the legacy `slug`). */
  tournamentSlug: z.string().min(1).nullish(),
  /** Event start, epoch ms, when the public data recorded one. */
  startAtMs: z.number().int().nonnegative().nullish(),
  /** Event end, epoch ms, when the public data recorded one. */
  endAtMs: z.number().int().nonnegative().nullish(),
  /** Sets actually played — DQs/byes excluded — when recorded. */
  playedSetCount: z.number().int().nonnegative().nullish(),
  /** DQ sets excluded from `playedSetCount`, when recorded. */
  dqCount: z.number().int().nonnegative().nullish(),
  provenance: historicalProvenanceSchema.nullish(),
});
export type HistoricalTournamentEntry = z.infer<typeof historicalTournamentEntrySchema>;

export const historicalTournamentEntryListSchema = z.array(historicalTournamentEntrySchema);

const ADMIN_IMPORTED_ORIGIN = 'admin-imported';

/** Display names for provider codes — provider names are never translated. */
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  startgg: 'start.gg',
  parrygg: 'parry.gg',
};

/**
 * Narrows a registry entry to its admin-imported historical fields, or
 * `null` for every manual/linked row. Accepts the base `TournamentEntry`
 * type so components typed against the shared schema can call it without
 * caring whether the extended parse ran upstream.
 */
export function getHistoricalFields(entry: TournamentEntry): HistoricalTournamentEntry | null {
  const candidate = entry as HistoricalTournamentEntry;
  return candidate.origin === ADMIN_IMPORTED_ORIGIN ? candidate : null;
}

/** True when the entry is an admin-imported (research-import) historical row. */
export function isAdminImportedEntry(entry: TournamentEntry): boolean {
  return getHistoricalFields(entry) != null;
}

/** The untranslated display name for an imported entry's provider ('start.gg' by default). */
export function importedProviderDisplayName(entry: TournamentEntry): string {
  const provider = getHistoricalFields(entry)?.provider ?? 'startgg';
  return PROVIDER_DISPLAY_NAMES[provider] ?? provider;
}

export interface EntryDateRange {
  startMs: number;
  endMs: number;
}

/**
 * The date range an entry should DISPLAY, or `null` when nothing was
 * recorded. Imported entries prefer the public data's own event dates
 * (`startAtMs`/`endAtMs`); every entry falls back to its observed set window
 * (`firstSetAt`/`lastSetAt`) only when those look like real timestamps —
 * epoch-zero placeholders render as missing, never as Jan 1 1970 (owner
 * directive: missing data is missing, not an inferred fact).
 */
export function entryDisplayDateRange(entry: TournamentEntry): EntryDateRange | null {
  const historical = getHistoricalFields(entry);
  if (historical?.startAtMs != null) {
    return { startMs: historical.startAtMs, endMs: historical.endAtMs ?? historical.startAtMs };
  }
  if (entry.firstSetAt > 0) {
    return {
      startMs: entry.firstSetAt,
      endMs: entry.lastSetAt > 0 ? entry.lastSetAt : entry.firstSetAt,
    };
  }
  return null;
}

/**
 * The played-set count an entry should display: imported rows prefer the
 * import's explicit DQ/bye-excluded `playedSetCount` when recorded; every
 * other row (and imported rows without one) uses the registry's accumulated
 * `setsPlayed`.
 */
export function entryDisplaySetsPlayed(entry: TournamentEntry): number {
  return getHistoricalFields(entry)?.playedSetCount ?? entry.setsPlayed;
}
