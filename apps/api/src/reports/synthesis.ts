import type { Database } from 'firebase-admin/database';
import {
  CITATION_LABEL_MAX_LENGTH,
  matchRecordSchema,
  REVIEW_CHECKLIST_ITEM_IDS,
  selectReviewResultsContext,
  serializeCitationToken,
  tournamentEntrySchema,
  type Match,
} from '@smash-tracker/shared';
import { normalizeOpponentTag } from '../startgg/sync.js';
// The one symbol this module imports from prep/ — a deliberately ONE-WAY
// dependency (28-CONTEXT.md / RESEARCH Pitfall 9, mirroring 27-06's
// `routes/reports.ts` precedent). Nothing in `apps/api/src/prep/` imports
// back from `reports/` — see `prep/importGraph.test.ts`.
import { readPrepBrief } from '../prep/prep.js';

// ---------------------------------------------------------------------------
// Payload assembly
// ---------------------------------------------------------------------------

/**
 * One citable moment of the caller's own stored evidence for this event.
 * `cite` is the server-pre-serialized `{{cite:...}}` token for this exact
 * item — the model is instructed to copy it verbatim (anti-hallucination
 * hardening, 28-RESEARCH Q3) rather than construct a token itself.
 * `matchId`/`seconds` are ALSO carried as plain fields (not just embedded in
 * `cite`) purely for payload readability; validation NEVER re-derives them
 * from `cite` — it re-extracts from the MODEL's output body via
 * `extractCitationTokens`, and resolves those against `allowedPairs`
 * (assembled here, see `assembleSynthesisPayload`'s return value).
 *
 * `tags` ride the evidence item's own text (embedded, (timestamp, string)
 * pairs) — there is no separate tag registry or tag-level citable id
 * (28-RESEARCH Q3 table).
 */
export interface SynthesisEvidenceItem {
  matchId: string;
  opponent: string | null;
  result: 'win' | 'loss';
  time: string;
  seconds: number;
  note: string;
  tags: string[];
  cite: string;
}

export interface SynthesisPayload {
  entry: {
    eventName: string;
    tournamentName: string | null;
    dates: { firstSetAt: string; lastSetAt: string };
  };
  briefContext: {
    reviewChecklistProgress: { completed: number; total: number };
    /** Canonical names from the brief's curated `likelyOpponents` presence map. */
    likelyOpponents: string[];
  };
  results: { wins: number; losses: number };
  evidence: SynthesisEvidenceItem[];
}

/**
 * Discriminated result of `assembleSynthesisPayload`: `found: false` when
 * the brief or the registry row is absent (a missing brief, a foreign
 * entryKey the caller never activated a prep brief for, or a raced
 * activation) — the route 404s on this, never falling back to a partial
 * assembly. Kept HTTP-free deliberately: this module never imports Fastify
 * or throws an HTTP-shaped error itself.
 */
export type AssembleSynthesisResult =
  | { found: false }
  | {
      found: true;
      payload: SynthesisPayload;
      /** Exactly `new Set(evidence.map((item) => item.cite))` — the server-pre-serialized token universe the model was shown. */
      allowedTokens: Set<string>;
      /** Exactly `new Set(evidence.map((item) => \`${item.matchId}:${item.seconds}\`))` — the set-membership universe `validatePracticePlanCitations` resolves against (owner invariant 1). */
      allowedPairs: Set<string>;
      evidenceCount: number;
    };

/**
 * Assembles the synthesis payload from the caller's OWN uid-scoped stored
 * trees ONLY (brief, registry row, matches, aliases) — there is no
 * parameter through which a caller can inject evidence (28-RESEARCH Security
 * Domain, T-28-19). Every evidence item is pre-tokenized with a
 * `serializeCitationToken` output, so the model never has to construct a
 * token character-by-character and validation is later a pure
 * set-membership check (owner invariant 1).
 *
 * Deliberately reuses `selectReviewResultsContext` (28-01) — the SAME
 * synced/manual classification the free review page renders (REV-02: the
 * plan is grounded in exactly what the review displays) — rather than
 * re-deriving its own event-match filter.
 *
 * The timestamp entry's `id` field (a synthesized, non-durable index value
 * for records still stored as a dense array — see `normalizeVodTimestampsNode`
 * and RESEARCH Pitfall 3) is deliberately NEVER read into the payload or the
 * token: the citable identifier is the stable `(matchId, seconds)` pair.
 */
export async function assembleSynthesisPayload(
  database: Database,
  uid: string,
  entryKey: string,
): Promise<AssembleSynthesisResult> {
  const [brief, registrySnapshot] = await Promise.all([
    readPrepBrief(database, uid, entryKey),
    database.ref(`tournamentEntries/${uid}/${entryKey}`).get(),
  ]);

  if (brief == null || !registrySnapshot.exists()) {
    return { found: false };
  }

  const entry = tournamentEntrySchema.parse(registrySnapshot.val());

  const [matchesSnapshot, aliasSnapshot] = await Promise.all([
    database.ref(`matches/${uid}`).get(),
    database.ref(`opponentAliases/${uid}`).get(),
  ]);

  // Single-hop alias lookup — opponentAliases/{uid} is already transitively
  // flattened by the write path, mirroring `assembleReportPayload`'s
  // established precedent (reports/generate.ts:245-260).
  const aliasMap = aliasSnapshot.exists()
    ? (aliasSnapshot.val() as Record<string, string>)
    : ({} as Record<string, string>);

  function canonicalOpponentName(name: string | undefined): string {
    const tag = normalizeOpponentTag(name);
    return aliasMap[tag] ?? tag;
  }

  // safeParse-and-skip (production-gap rule, mirrors RtdbService.listMatches):
  // parses through `matchRecordSchema` (NOT `matchSchema` — the latter
  // re-declares `vodTimestamps` as a plain, non-preprocess array schema for
  // encode-safety, which would reject both raw shapes `vodTimestamps` can
  // actually be stored in). `matchRecordSchema`'s preprocess runs
  // `normalizeVodTimestampsNode`, so every entry below already carries a
  // normalized, id-bearing, seconds-sorted `VodTimestamp[]` regardless of
  // whether the raw node was a legacy dense array or a keyed push-key
  // subtree.
  const rawMatches: Match[] = matchesSnapshot.exists()
    ? Object.entries(matchesSnapshot.val() as Record<string, unknown>).flatMap(([id, value]) => {
        const parsed = matchRecordSchema.safeParse(value);
        if (!parsed.success) {
          return [];
        }
        return [{ id, ...parsed.data } as Match];
      })
    : [];

  const aliasResolvedMatches: Match[] = rawMatches.map((match) =>
    match.opponent ? { ...match, opponent: canonicalOpponentName(match.opponent) } : match,
  );

  const { synced, manual } = selectReviewResultsContext(
    aliasResolvedMatches,
    entry,
    brief.likelyOpponents,
  );
  const eventMatches = [...synced, ...manual];

  const evidence: SynthesisEvidenceItem[] = [];
  for (const match of eventMatches) {
    const timestamps = match.vodTimestamps ?? [];
    for (const timestamp of timestamps) {
      const noteText = timestamp.note.trim();
      const rawLabel = noteText.length > 0 ? noteText : `vs ${match.opponent ?? 'opponent'}`;
      const label = rawLabel.slice(0, CITATION_LABEL_MAX_LENGTH);
      const cite = serializeCitationToken({
        sourceVodRef: match.id,
        seconds: timestamp.seconds,
        label,
      });
      evidence.push({
        matchId: match.id,
        opponent: match.opponent ?? null,
        result: match.win ? 'win' : 'loss',
        time: new Date(match.time).toISOString(),
        seconds: timestamp.seconds,
        note: timestamp.note,
        tags: timestamp.tags ?? [],
        cite,
      });
    }
  }

  const allowedTokens = new Set(evidence.map((item) => item.cite));
  const allowedPairs = new Set(evidence.map((item) => `${item.matchId}:${item.seconds}`));

  const wins = eventMatches.filter((match) => match.win).length;
  const losses = eventMatches.length - wins;

  const payload: SynthesisPayload = {
    entry: {
      eventName: entry.eventName,
      tournamentName: entry.tournamentName ?? null,
      dates: {
        firstSetAt: new Date(entry.firstSetAt).toISOString(),
        lastSetAt: new Date(entry.lastSetAt).toISOString(),
      },
    },
    briefContext: {
      reviewChecklistProgress: {
        completed: Object.keys(brief.reviewChecklist).length,
        total: REVIEW_CHECKLIST_ITEM_IDS.length,
      },
      likelyOpponents: Object.keys(brief.likelyOpponents),
    },
    results: { wins, losses },
    evidence,
  };

  return { found: true, payload, allowedTokens, allowedPairs, evidenceCount: evidence.length };
}
