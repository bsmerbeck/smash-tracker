import type { Database } from 'firebase-admin/database';
import { CANONICAL_SCHEMA_VERSION, type OnboardingIntent } from '@smash-tracker/shared';
import { buildDomainEnvelope } from '../events/envelope.js';
import { createEvent } from '../events/ledger.js';
import { RtdbService } from '../services/rtdb.js';

/**
 * Phase 13 (ONBD-04, D-04): the player-activation engine. Four milestone D
 * events — analytics_activated, vod_activated, tournament_prep_activated,
 * scout_activated — fire once per user at the SAME server conditions D-04
 * names in prose ("one VOD + two notes"; "five valid games"; "event
 * linked"; "scout success"), deduped forever via `createEvent`'s
 * `eventDedup/{eventName}/{schemaVersion}/{causationId}` transaction, with
 * `causationId` LOCKED to the user's own uid — mirrors 13-02's
 * `onboarding_intent_selected`/`coaching_mode_enabled` (RESEARCH.md Pattern
 * 3): the mutated "resource" here is the user's own activation milestone,
 * not any one match/report, so the dedup key is the uid, never a
 * per-resource id.
 *
 * `GET /api/onboarding/progress` (routes/onboarding.ts) reads the SAME
 * `eventDedup` markers via `computeActivationState` — by construction the
 * checklist can never drift from the events that actually fired (D-04's
 * explicit anti-pattern: no parallel client-side counter).
 */

/** "Five valid games" (D-04) = five personal match records, any source. */
export const ANALYTICS_MIN_GAMES = 5;

/**
 * "One VOD + two notes" (D-04): a personal match reaches vod_activated once
 * it has a `vodUrl` AND at least this many `vodTimestamps` entries.
 */
export const VOD_MIN_NOTES = 2;

type PlayerActivationKind = 'analytics' | 'vod' | 'tournament_prep' | 'scout';

const ACTIVATION_EVENT_NAMES: Record<PlayerActivationKind, string> = {
  analytics: 'analytics_activated',
  vod: 'vod_activated',
  tournament_prep: 'tournament_prep_activated',
  scout: 'scout_activated',
};

async function readOnboardingIntent(
  database: Database,
  uid: string,
): Promise<OnboardingIntent | null> {
  const snapshot = await database.ref(`users/${uid}/onboardingIntent`).get();
  return (snapshot.val() as OnboardingIntent | null) ?? null;
}

/**
 * Returns the onboarding-causation payload field for a durable transition
 * attributable to the coach's saved intent (used by coach-path emissions
 * outside this module, e.g. `client_vod_attached`). Never carried in
 * `causationId` (RESEARCH.md Pattern 3) — payload values stay primitives
 * only, per the envelope's `z.union([string, number, boolean])` constraint.
 */
export async function onboardingCausePayload(
  database: Database,
  coachUid: string,
): Promise<Record<string, string>> {
  const intent = await readOnboardingIntent(database, coachUid);
  return intent === 'coach_clients' ? { onboardingCause: intent } : {};
}

/**
 * Emits ONE player activation milestone event, deduped once per user
 * forever (causationId = uid). Fire-and-forget at every call site — mirrors
 * `managed_client_created`'s "the durable write already committed" shape
 * (the RTDB read/write this reconciles from has already committed by the
 * time this is called).
 */
async function emitPlayerActivation(
  database: Database,
  uid: string,
  sessionId: string,
  kind: PlayerActivationKind,
): Promise<void> {
  const intent = await readOnboardingIntent(database, uid);
  await createEvent(
    database,
    buildDomainEnvelope({
      eventName: ACTIVATION_EVENT_NAMES[kind],
      actorId: uid,
      sessionId,
      causationId: uid,
      consentState: 'unknown',
      payload: intent ? { onboardingCause: intent } : {},
    }),
  );
}

/**
 * Re-evaluates the user's personal library after a personal durable write
 * (a new match, a vodUrl attach, a new note) and emits any of
 * analytics_activated / vod_activated / tournament_prep_activated that just
 * became true. Idempotent — `createEvent`'s ledger dedup absorbs repeat
 * calls, so this is safe to call after EVERY personal write rather than
 * only the one call that happens to cross a threshold.
 *
 * `scout_activated` has no durable RTDB state to reconcile from (a scout
 * lookup never writes a record) — see `emitScoutActivated` below.
 */
export async function reconcilePlayerActivation(
  database: Database,
  uid: string,
  sessionId: string,
): Promise<void> {
  const rtdb = new RtdbService(database);
  const [matches, tournamentEntriesSnapshot] = await Promise.all([
    rtdb.listMatches(uid),
    database.ref(`tournamentEntries/${uid}`).get(),
  ]);

  const emissions: Promise<void>[] = [];

  if (matches.length >= ANALYTICS_MIN_GAMES) {
    emissions.push(emitPlayerActivation(database, uid, sessionId, 'analytics'));
  }

  const hasVodWithNotes = matches.some(
    (match) => match.vodUrl !== undefined && (match.vodTimestamps?.length ?? 0) >= VOD_MIN_NOTES,
  );
  if (hasVodWithNotes) {
    emissions.push(emitPlayerActivation(database, uid, sessionId, 'vod'));
  }

  if (tournamentEntriesSnapshot.exists()) {
    emissions.push(emitPlayerActivation(database, uid, sessionId, 'tournament_prep'));
  }

  await Promise.all(emissions);
}

/**
 * Scout success has no durable RTDB write to reconcile from — fired
 * directly at each of `POST /scout`'s successful-report return points.
 * Dedups once per user forever, same as the reconciled events above.
 */
export async function emitScoutActivated(
  database: Database,
  uid: string,
  sessionId: string,
): Promise<void> {
  await emitPlayerActivation(database, uid, sessionId, 'scout');
}

export interface PlayerActivationState {
  analytics: boolean;
  vod: boolean;
  tournamentPrep: boolean;
  scout: boolean;
}

/**
 * D-04: the checklist's done-state IS the activation state by construction
 * — reads the SAME `eventDedup` markers the emit functions above write,
 * never a parallel client-facing counter.
 */
export async function computeActivationState(
  database: Database,
  uid: string,
): Promise<PlayerActivationState> {
  const [analytics, vod, tournamentPrep, scout] = await Promise.all([
    database.ref(`eventDedup/analytics_activated/${CANONICAL_SCHEMA_VERSION}/${uid}`).get(),
    database.ref(`eventDedup/vod_activated/${CANONICAL_SCHEMA_VERSION}/${uid}`).get(),
    database.ref(`eventDedup/tournament_prep_activated/${CANONICAL_SCHEMA_VERSION}/${uid}`).get(),
    database.ref(`eventDedup/scout_activated/${CANONICAL_SCHEMA_VERSION}/${uid}`).get(),
  ]);
  return {
    analytics: analytics.exists(),
    vod: vod.exists(),
    tournamentPrep: tournamentPrep.exists(),
    scout: scout.exists(),
  };
}
