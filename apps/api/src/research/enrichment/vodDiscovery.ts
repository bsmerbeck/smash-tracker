import type { Database } from 'firebase-admin/database';
import {
  isPathSafeProviderId,
  researchEnrichmentVodCandidateRecordSchema,
  researchSourceSetRecordSchema,
  type ResearchEnrichmentVodCandidateRecord,
  type ResearchSourceSetRecord,
} from '@smash-tracker/shared';
import type { YoutubeConfig } from '../../config/env.js';
import { isPathSafeTenantId } from '../subjectKind.js';

/**
 * Phase 30.3 Gate 5 — bounded YouTube VOD candidate discovery and the
 * candidates store (`researchEnrichmentVodCandidates/{tenantId}/
 * {targetSetId}/{candidateId}`, a `nested-two-level` tree registered in
 * `TENANT_DELETION_TREES` and the migration descriptor registry alongside
 * its enrichment siblings).
 *
 * THE CANDIDATE CONTRACT (directive, verbatim): search results are
 * CANDIDATES, not facts. Every record persists the query that produced it,
 * the result's identity members (video id, title, channel, publication
 * date), the fetch time, and a heuristic score — and NOTHING projects from
 * this tree until an explicit admin confirmation stamps the record
 * (`confirmVodCandidateByAdmin` below, an identifiers-only reload-and-stamp
 * door mirroring `store.ts`'s admin attachment door). The projection
 * applier reads ONLY confirmed candidates, and only at the BOTTOM of the
 * VOD source-priority chain: 1 user/manual URL, 2 provider URL, 3 directly
 * matched Liquipedia bracket URL, 4 corroborated Liquipedia player-VOD-page
 * URL, 5 admin-confirmed YouTube Data API candidate. Priorities 1–2 are the
 * shared resolver's own ownership rules; 3–4 are attached-observation
 * overlay entries (bracket outranks vodlist in `buildEnrichmentOverlay`);
 * 5 is `readConfirmedCandidateVodForSet` below, which the applier merges
 * ONLY into row keys no observation URL already covers.
 *
 * THE DISCOVERY BOUND (directive: exhaustive career-wide discovery is a
 * NON-GOAL): one discovery pass queries at most
 * `VOD_DISCOVERY_MAX_SETS_PER_RUN` target sets, selected recent-first
 * (`completedAt` descending) from the sets that are UNMATCHED — projected
 * rows exist and none of them carries any `vodUrl` from any source — and
 * not already discovered (any existing candidate child skips the set,
 * protecting both the API quota and prior admin decisions). The bound is
 * exposed on the report (`bound`), never implicit.
 *
 * NETWORK POSTURE: YouTube Data API ONLY (`YOUTUBE_SEARCH_ENDPOINT`), via
 * an INJECTED `fetchImpl` — there is no default-fetch path, mirroring the
 * Liquipedia client's compile-time gate — and a null `YoutubeConfig` means
 * discovery is DISABLED (the route answers 503), never "try another way".
 * Scraping YouTube HTML is forbidden in every configuration.
 */

export const YOUTUBE_SEARCH_ENDPOINT = 'https://www.googleapis.com/youtube/v3/search';

/** The explicit discovery bound: at most this many target sets are queried per discovery pass. */
export const VOD_DISCOVERY_MAX_SETS_PER_RUN = 20;

/** Results requested per set query — the Data API's `maxResults`. */
export const VOD_DISCOVERY_MAX_RESULTS_PER_SET = 5;

/** How many game ordinals the applier probes when attaching a confirmed candidate to existing rows (see `readConfirmedCandidateVodForSet`'s doc). */
export const VOD_CANDIDATE_MAX_ORDINAL_PROBE = 10;

// ---------------------------------------------------------------------------
// Refs + store
// ---------------------------------------------------------------------------

function candidateRef(
  database: Database,
  tenantId: string,
  targetSetId: string,
  candidateId: string,
) {
  return database.ref(`researchEnrichmentVodCandidates/${tenantId}/${targetSetId}/${candidateId}`);
}

function candidatesTreeRef(database: Database, tenantId: string) {
  return database.ref(`researchEnrichmentVodCandidates/${tenantId}`);
}

function candidatesForSetRef(database: Database, tenantId: string, targetSetId: string) {
  return database.ref(`researchEnrichmentVodCandidates/${tenantId}/${targetSetId}`);
}

export type VodCandidateWriteOutcome = 'created' | 'skipped-existing' | 'rejected-key';

/**
 * Persists one candidate ONLY IF ABSENT — an existing record (whatever its
 * status) is never overwritten, so a re-discovery pass can never downgrade
 * an admin's confirmation or resurrect a dismissal.
 */
export async function writeVodCandidate(
  database: Database,
  tenantId: string,
  record: ResearchEnrichmentVodCandidateRecord,
): Promise<{ outcome: VodCandidateWriteOutcome }> {
  if (
    !isPathSafeTenantId(tenantId) ||
    !isPathSafeProviderId(record.targetSetId) ||
    !isPathSafeProviderId(record.candidateId)
  ) {
    return { outcome: 'rejected-key' };
  }
  const parsed = researchEnrichmentVodCandidateRecordSchema.parse(record);
  const ref = candidateRef(database, tenantId, record.targetSetId, record.candidateId);
  const existing = await ref.get();
  if (existing.exists()) {
    return { outcome: 'skipped-existing' };
  }
  await ref.set(parsed);
  return { outcome: 'created' };
}

/** Safe-parses every child independently; deterministic order (status, then targetSetId, then score descending, then candidateId). */
export async function listVodCandidatesForTenant(
  database: Database,
  tenantId: string,
): Promise<ResearchEnrichmentVodCandidateRecord[]> {
  if (!isPathSafeTenantId(tenantId)) {
    return [];
  }
  const snapshot = await candidatesTreeRef(database, tenantId).get();
  const raw = snapshot.val() as Record<string, Record<string, unknown>> | null;
  if (raw === null || typeof raw !== 'object') {
    return [];
  }
  const records: ResearchEnrichmentVodCandidateRecord[] = [];
  for (const children of Object.values(raw)) {
    if (children === null || typeof children !== 'object') {
      continue;
    }
    for (const value of Object.values(children)) {
      const parsed = researchEnrichmentVodCandidateRecordSchema.safeParse(value);
      if (parsed.success) {
        records.push(parsed.data);
      }
    }
  }
  return records.sort(
    (a, b) =>
      a.status.localeCompare(b.status) ||
      a.targetSetId.localeCompare(b.targetSetId) ||
      b.score - a.score ||
      a.candidateId.localeCompare(b.candidateId),
  );
}

/** The CONFIRMED candidates for one set, strongest first (score descending, then candidateId for determinism). */
export async function listConfirmedVodCandidatesForSet(
  database: Database,
  tenantId: string,
  targetSetId: string,
): Promise<ResearchEnrichmentVodCandidateRecord[]> {
  if (!isPathSafeTenantId(tenantId) || !isPathSafeProviderId(targetSetId)) {
    return [];
  }
  const snapshot = await candidatesForSetRef(database, tenantId, targetSetId).get();
  const raw = snapshot.val() as Record<string, unknown> | null;
  if (raw === null || typeof raw !== 'object') {
    return [];
  }
  const confirmed: ResearchEnrichmentVodCandidateRecord[] = [];
  for (const value of Object.values(raw)) {
    const parsed = researchEnrichmentVodCandidateRecordSchema.safeParse(value);
    if (parsed.success && parsed.data.status === 'confirmed') {
      confirmed.push(parsed.data);
    }
  }
  return confirmed.sort((a, b) => b.score - a.score || a.candidateId.localeCompare(b.candidateId));
}

/**
 * The ONE value the applier's priority-5 merge consumes: the strongest
 * confirmed candidate's URL and id for a set, or `null`. When two
 * candidates are confirmed for one set, the deterministic strongest-first
 * order above decides — never insertion order.
 */
export async function readConfirmedCandidateVodForSet(
  database: Database,
  tenantId: string,
  targetSetId: string,
): Promise<{ candidateId: string; videoUrl: string } | null> {
  const confirmed = await listConfirmedVodCandidatesForSet(database, tenantId, targetSetId);
  const strongest = confirmed[0];
  return strongest ? { candidateId: strongest.candidateId, videoUrl: strongest.videoUrl } : null;
}

export type VodCandidateConfirmOutcome =
  'confirmed' | 'already-confirmed' | 'rejected-not-found' | 'rejected-key';

/**
 * The explicit human door — IDENTIFIERS ONLY, mirroring
 * `confirmEnrichmentObservationByAdmin`: the stored candidate is RELOADED
 * and re-stamped; nothing the caller supplies beyond the ids is trusted. A
 * dismissed candidate CAN be confirmed (the admin's later explicit action
 * supersedes the earlier one); the dismissal stamps are cleared by the
 * rebuild below (conditional-spread write, house null-stripping rule).
 */
export async function confirmVodCandidateByAdmin(
  database: Database,
  tenantId: string,
  targetSetId: string,
  candidateId: string,
  adminUid: string,
  nowMs: number,
): Promise<{ outcome: VodCandidateConfirmOutcome }> {
  if (
    !isPathSafeTenantId(tenantId) ||
    !isPathSafeProviderId(targetSetId) ||
    !isPathSafeProviderId(candidateId)
  ) {
    return { outcome: 'rejected-key' };
  }
  const ref = candidateRef(database, tenantId, targetSetId, candidateId);
  const snapshot = await ref.get();
  const stored = researchEnrichmentVodCandidateRecordSchema.safeParse(
    snapshot.exists() ? snapshot.val() : null,
  );
  if (!stored.success) {
    return { outcome: 'rejected-not-found' };
  }
  if (stored.data.status === 'confirmed') {
    return { outcome: 'already-confirmed' };
  }
  const confirmed = researchEnrichmentVodCandidateRecordSchema.parse({
    candidateId: stored.data.candidateId,
    targetSetId: stored.data.targetSetId,
    provider: stored.data.provider,
    query: stored.data.query,
    videoId: stored.data.videoId,
    videoUrl: stored.data.videoUrl,
    title: stored.data.title,
    ...(stored.data.channelId != null ? { channelId: stored.data.channelId } : {}),
    ...(stored.data.channelTitle != null ? { channelTitle: stored.data.channelTitle } : {}),
    ...(stored.data.publishedAt != null ? { publishedAt: stored.data.publishedAt } : {}),
    fetchedAtMs: stored.data.fetchedAtMs,
    score: stored.data.score,
    status: 'confirmed',
    confirmedByUid: adminUid,
    confirmedAtMs: nowMs,
  });
  await ref.set(confirmed);
  return { outcome: 'confirmed' };
}

/**
 * Marks a candidate dismissed (idempotent; a missing candidate is a no-op).
 * Dismissing a CONFIRMED candidate is allowed — the caller (the route)
 * re-applies the set's projection afterwards so a projected URL the
 * candidate vouched for is removed through the ordinary witness discipline,
 * never left dangling.
 */
export async function dismissVodCandidateByAdmin(
  database: Database,
  tenantId: string,
  targetSetId: string,
  candidateId: string,
  adminUid: string,
  nowMs: number,
): Promise<{ ok: true }> {
  if (
    !isPathSafeTenantId(tenantId) ||
    !isPathSafeProviderId(targetSetId) ||
    !isPathSafeProviderId(candidateId)
  ) {
    return { ok: true };
  }
  const ref = candidateRef(database, tenantId, targetSetId, candidateId);
  const snapshot = await ref.get();
  const stored = researchEnrichmentVodCandidateRecordSchema.safeParse(
    snapshot.exists() ? snapshot.val() : null,
  );
  if (!stored.success) {
    return { ok: true };
  }
  const dismissed = researchEnrichmentVodCandidateRecordSchema.parse({
    candidateId: stored.data.candidateId,
    targetSetId: stored.data.targetSetId,
    provider: stored.data.provider,
    query: stored.data.query,
    videoId: stored.data.videoId,
    videoUrl: stored.data.videoUrl,
    title: stored.data.title,
    ...(stored.data.channelId != null ? { channelId: stored.data.channelId } : {}),
    ...(stored.data.channelTitle != null ? { channelTitle: stored.data.channelTitle } : {}),
    ...(stored.data.publishedAt != null ? { publishedAt: stored.data.publishedAt } : {}),
    fetchedAtMs: stored.data.fetchedAtMs,
    score: stored.data.score,
    status: 'dismissed',
    dismissedByUid: adminUid,
    dismissedAtMs: nowMs,
  });
  await ref.set(dismissed);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Target selection — the bounded, recent-first unmatched-set pass
// ---------------------------------------------------------------------------

export interface VodDiscoveryTarget {
  targetSetId: string;
  query: string;
  /** The scoring context, carried alongside the query so `scoreVodCandidate` never re-derives it from the query string. */
  entrantNames: string[];
  tournamentName?: string;
  roundText?: string;
}

/** Builds the search query for one set: tournament + both entrant tags + round. Returns `null` when the record has too little identity to search usefully (no tournament/event name or fewer than two entrant names). */
export function buildVodDiscoveryQuery(record: ResearchSourceSetRecord): string | null {
  const tournament = record.event?.tournamentName?.trim() || record.event?.name?.trim();
  const names = (record.entrants ?? [])
    .map((entrant) => entrant.name?.trim())
    .filter((name): name is string => name != null && name.length > 0);
  if (!tournament || names.length < 2) {
    return null;
  }
  const round = record.fullRoundText?.trim();
  return [tournament, `${names[0]} vs ${names[1]}`, round ?? '']
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

/**
 * The pure scoring heuristic, exposed for tests: +2 per entrant tag found
 * in the title, +1 when at least half the tournament-name tokens appear,
 * +1 when the round text appears. Scores rank candidates for the ADMIN —
 * they authorize nothing.
 */
export function scoreVodCandidate(input: {
  title: string;
  entrantNames: string[];
  tournamentName?: string;
  roundText?: string;
}): number {
  const title = input.title.toLowerCase();
  let score = 0;
  for (const name of input.entrantNames) {
    const needle = name.trim().toLowerCase();
    if (needle.length > 0 && title.includes(needle)) {
      score += 2;
    }
  }
  if (input.tournamentName) {
    const tokens = input.tournamentName
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2);
    if (tokens.length > 0) {
      const present = tokens.filter((token) => title.includes(token)).length;
      if (present * 2 >= tokens.length) {
        score += 1;
      }
    }
  }
  if (input.roundText && title.includes(input.roundText.trim().toLowerCase())) {
    score += 1;
  }
  return score;
}

interface SelectableSet {
  targetSetId: string;
  record: ResearchSourceSetRecord;
  completedAt: number;
}

/**
 * Selects the bounded, recent-first target list: sets with projected rows,
 * NONE of which carries a `vodUrl` from any source, that have no candidate
 * children yet. Reads the set tier once and each candidate set's projected
 * rows once; the per-invocation cost is bounded by the tenant's set count
 * plus `bound × projected-row-count`.
 */
export async function selectVodDiscoveryTargets(
  database: Database,
  tenantId: string,
  bound: number,
): Promise<{ consideredSets: number; targets: VodDiscoveryTarget[] }> {
  if (!isPathSafeTenantId(tenantId)) {
    return { consideredSets: 0, targets: [] };
  }
  const setsSnapshot = await database.ref(`researchSource/${tenantId}/sets`).get();
  const rawSets = setsSnapshot.val() as Record<string, unknown> | null;
  if (rawSets === null || typeof rawSets !== 'object') {
    return { consideredSets: 0, targets: [] };
  }

  const candidatesSnapshot = await candidatesTreeRef(database, tenantId).get();
  const alreadyDiscovered = new Set(
    Object.keys((candidatesSnapshot.val() as Record<string, unknown> | null) ?? {}),
  );

  const selectable: SelectableSet[] = [];
  for (const [storageKey, value] of Object.entries(rawSets)) {
    const parsed = researchSourceSetRecordSchema.safeParse(value);
    if (!parsed.success) {
      continue;
    }
    const record = parsed.data;
    const projectedKeys = record.projectedMatchKeys ?? [];
    if (projectedKeys.length === 0 || alreadyDiscovered.has(storageKey)) {
      continue;
    }
    selectable.push({
      targetSetId: storageKey,
      record,
      completedAt: record.completedAt ?? 0,
    });
  }
  const consideredSets = selectable.length;
  selectable.sort(
    (a, b) => b.completedAt - a.completedAt || a.targetSetId.localeCompare(b.targetSetId),
  );

  const targets: VodDiscoveryTarget[] = [];
  for (const candidate of selectable) {
    if (targets.length >= bound) {
      break;
    }
    if (!isPathSafeProviderId(candidate.targetSetId)) {
      continue;
    }
    // Unmatched = no row of the set carries a vodUrl from ANY source.
    let hasAnyVod = false;
    for (const key of candidate.record.projectedMatchKeys ?? []) {
      if (!isPathSafeProviderId(key)) {
        continue;
      }
      const row = await database.ref(`matches/${tenantId}/${key}`).get();
      const value = row.val() as { vodUrl?: unknown } | null;
      if (value && typeof value.vodUrl === 'string' && value.vodUrl.length > 0) {
        hasAnyVod = true;
        break;
      }
    }
    if (hasAnyVod) {
      continue;
    }
    const query = buildVodDiscoveryQuery(candidate.record);
    if (query === null) {
      continue;
    }
    const entrantNames = (candidate.record.entrants ?? [])
      .map((entrant) => entrant.name?.trim())
      .filter((name): name is string => name != null && name.length > 0);
    const tournamentName =
      candidate.record.event?.tournamentName?.trim() || candidate.record.event?.name?.trim();
    const roundText = candidate.record.fullRoundText?.trim();
    targets.push({
      targetSetId: candidate.targetSetId,
      query,
      entrantNames,
      ...(tournamentName ? { tournamentName } : {}),
      ...(roundText ? { roundText } : {}),
    });
  }

  return { consideredSets, targets };
}

// ---------------------------------------------------------------------------
// The discovery pass — YouTube Data API only, injected fetch only
// ---------------------------------------------------------------------------

export interface YoutubeDiscoveryDeps {
  config: YoutubeConfig;
  /** REQUIRED — no default-fetch path exists, mirroring the Liquipedia client's compile-time gate. */
  fetchImpl: typeof fetch;
}

export interface VodDiscoveryReport {
  /** The explicit bound this pass ran under. */
  bound: number;
  consideredSets: number;
  queriedSets: number;
  candidatesWritten: number;
  candidatesSkippedExisting: number;
  queryFailures: number;
}

interface YoutubeSearchItem {
  id?: { videoId?: unknown };
  snippet?: {
    title?: unknown;
    channelId?: unknown;
    channelTitle?: unknown;
    publishedAt?: unknown;
  };
}

function clampText(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : undefined;
}

/**
 * Runs ONE bounded discovery pass for a tenant. Every persisted result is a
 * `proposed` candidate; nothing here writes a projection, a witness, or a
 * match row. A per-set fetch/parse failure counts as a `queryFailure` and
 * the pass continues — one flaky query never voids the rest of the bound.
 */
export async function runVodCandidateDiscovery(
  database: Database,
  tenantId: string,
  deps: YoutubeDiscoveryDeps,
  nowMs: number,
  maxSets: number = VOD_DISCOVERY_MAX_SETS_PER_RUN,
): Promise<VodDiscoveryReport> {
  const bound = Math.max(1, Math.min(maxSets, VOD_DISCOVERY_MAX_SETS_PER_RUN));
  const report: VodDiscoveryReport = {
    bound,
    consideredSets: 0,
    queriedSets: 0,
    candidatesWritten: 0,
    candidatesSkippedExisting: 0,
    queryFailures: 0,
  };
  if (!isPathSafeTenantId(tenantId)) {
    return report;
  }

  const { consideredSets, targets } = await selectVodDiscoveryTargets(database, tenantId, bound);
  report.consideredSets = consideredSets;

  for (const target of targets) {
    const url = new URL(YOUTUBE_SEARCH_ENDPOINT);
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('type', 'video');
    url.searchParams.set('maxResults', String(VOD_DISCOVERY_MAX_RESULTS_PER_SET));
    url.searchParams.set('q', target.query);
    url.searchParams.set('key', deps.config.apiKey);

    let items: YoutubeSearchItem[];
    try {
      const response = await deps.fetchImpl(url.toString());
      if (!response.ok) {
        report.queryFailures += 1;
        continue;
      }
      const body = (await response.json()) as { items?: unknown };
      items = Array.isArray(body.items) ? (body.items as YoutubeSearchItem[]) : [];
    } catch {
      report.queryFailures += 1;
      continue;
    }
    report.queriedSets += 1;

    for (const item of items) {
      const videoId = typeof item.id?.videoId === 'string' ? item.id.videoId : undefined;
      if (!videoId || !isPathSafeProviderId(`yt-${videoId}`)) {
        continue;
      }
      const title = clampText(item.snippet?.title, 300) ?? '';
      const channelId = clampText(item.snippet?.channelId, 200);
      const channelTitle = clampText(item.snippet?.channelTitle, 300);
      const publishedAt = clampText(item.snippet?.publishedAt, 40);

      const record = researchEnrichmentVodCandidateRecordSchema.parse({
        candidateId: `yt-${videoId}`,
        targetSetId: target.targetSetId,
        provider: 'youtube-data-api',
        query: target.query,
        videoId,
        videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
        title,
        ...(channelId !== undefined ? { channelId } : {}),
        ...(channelTitle !== undefined ? { channelTitle } : {}),
        ...(publishedAt !== undefined ? { publishedAt } : {}),
        fetchedAtMs: nowMs,
        score: scoreVodCandidate({
          title,
          entrantNames: target.entrantNames,
          ...(target.tournamentName !== undefined ? { tournamentName: target.tournamentName } : {}),
          ...(target.roundText !== undefined ? { roundText: target.roundText } : {}),
        }),
        status: 'proposed',
      });
      const write = await writeVodCandidate(database, tenantId, record);
      if (write.outcome === 'created') {
        report.candidatesWritten += 1;
      } else if (write.outcome === 'skipped-existing') {
        report.candidatesSkippedExisting += 1;
      }
    }
  }

  return report;
}
