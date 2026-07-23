import { randomUUID } from 'node:crypto';
import type { Database } from 'firebase-admin/database';
import {
  trainingSessionSchema,
  type HomeworkItem,
  type TrainingSession,
} from '@smash-tracker/shared';
import { NotFoundError } from '../services/rtdb.js';

/**
 * Phase 20 (Coaching Workflow, Training Sessions & VOD-less Reviews,
 * SESS-01/02): the coach-side training-session CRUD service — plain
 * exported functions taking `(database, tenantId, ...)`, mirroring
 * `apps/api/src/coaching/reviews.ts`'s module shape exactly (same
 * `NotFoundError` import, same safeParse-and-skip list discipline, same
 * conditional-spread write idiom per CONCERNS.md).
 *
 * A session is a MUTABLE LOG (V22-TRAINING-SESSION-RESEARCH Pattern 1): ONE
 * live record per session at `trainingSessions/{tenantId}/{sessionId}`,
 * edited in place by `updateSession`/`toggleHomeworkItem`. There is
 * deliberately NO sibling version/publish/status tree here, unlike
 * `reviews.ts` — a session has no draft/published distinction to track.
 */

/** Input to `createSession` — homework items arrive without an `id`; the service generates one per item so `toggleHomeworkItem` can address it later. */
export interface CreateSessionInput {
  date: number;
  characterTags?: number[];
  summary: string;
  homework?: Array<{ text: string; done?: boolean }>;
  linkedMatchIds?: string[] | null;
  coachPrivateNotes?: string | null;
}

/**
 * Real RTDB (and `FakeDatabase`, mirroring it) drops any key whose value is
 * an empty array on write — a session with zero character tags or zero
 * homework items round-trips with NO `characterTags`/`homework` key at all.
 * Every READ of a session record must normalize those missing keys back to
 * `[]` before validating — the same discipline `reviews.ts`'s
 * `parseDraftRecord` established for `sections`.
 */
function parseSessionRecord(raw: unknown): TrainingSession {
  const normalized =
    raw !== null && typeof raw === 'object'
      ? {
          ...(raw as Record<string, unknown>),
          characterTags: (raw as { characterTags?: unknown }).characterTags ?? [],
          homework: (raw as { homework?: unknown }).homework ?? [],
        }
      : raw;
  return trainingSessionSchema.parse(normalized);
}

/**
 * Creates a new training session (SESS-01): a push-keyed
 * `trainingSessions/{tenantId}/{sessionId}` record, `createdAt` ===
 * `lastEditedAt` on creation. Homework items are assigned a stable
 * `randomUUID()` id here — the input never carries one.
 */
export async function createSession(
  database: Database,
  tenantId: string,
  input: CreateSessionInput,
): Promise<{ sessionId: string } & TrainingSession> {
  const now = Date.now();
  const homework: HomeworkItem[] = (input.homework ?? []).map((item) => ({
    id: randomUUID(),
    text: item.text,
    done: item.done ?? false,
  }));

  const record = trainingSessionSchema.parse({
    date: input.date,
    characterTags: input.characterTags ?? [],
    summary: input.summary,
    homework,
    ...(input.linkedMatchIds !== undefined ? { linkedMatchIds: input.linkedMatchIds } : {}),
    ...(input.coachPrivateNotes !== undefined
      ? { coachPrivateNotes: input.coachPrivateNotes }
      : {}),
    createdAt: now,
    lastEditedAt: now,
  } satisfies TrainingSession);

  const ref = database.ref(`trainingSessions/${tenantId}`).push();
  await ref.set(record);
  const sessionId = ref.key;
  if (!sessionId) {
    throw new Error('Failed to generate a push key for the new training session');
  }

  return { sessionId, ...record };
}

/**
 * Lists every session for a tenant, most-recent-first (by `date`, ties
 * broken by `createdAt`). Corrupt records are skipped (safeParse-and-skip),
 * never thrown on — mirrors `reviews.ts`'s list discipline.
 */
export async function listSessions(
  database: Database,
  tenantId: string,
): Promise<Array<{ sessionId: string } & TrainingSession>> {
  const snapshot = await database.ref(`trainingSessions/${tenantId}`).get();
  if (!snapshot.exists()) {
    return [];
  }
  const raw = snapshot.val() as Record<string, unknown>;
  const sessions = Object.entries(raw).flatMap(([sessionId, value]) => {
    const normalized =
      value !== null && typeof value === 'object'
        ? {
            ...(value as Record<string, unknown>),
            characterTags: (value as { characterTags?: unknown }).characterTags ?? [],
            homework: (value as { homework?: unknown }).homework ?? [],
          }
        : value;
    const parsed = trainingSessionSchema.safeParse(normalized);
    return parsed.success ? [{ sessionId, ...parsed.data }] : [];
  });

  return sessions.sort((a, b) => {
    if (b.date !== a.date) return b.date - a.date;
    return b.createdAt - a.createdAt;
  });
}

/** Fetches one session's full (coach-facing) record. Throws `NotFoundError` if it doesn't exist. */
export async function getSession(
  database: Database,
  tenantId: string,
  sessionId: string,
): Promise<{ sessionId: string } & TrainingSession> {
  const snapshot = await database.ref(`trainingSessions/${tenantId}/${sessionId}`).get();
  if (!snapshot.exists()) {
    throw new NotFoundError(`Training session ${sessionId} not found`);
  }
  return { sessionId, ...parseSessionRecord(snapshot.val()) };
}

/**
 * Applies a partial in-place update (SESS-02: "a coach can update a
 * session") — a single `.update()` on the one node, NO version seal, NO
 * sibling status tree (mutable log, Pattern 1). Stamps `lastEditedAt`.
 * Homework items in a patch are trusted as-is (they carry their own `id`,
 * assigned at creation or by a previous patch) — this is a full-array
 * replace of `homework`, mirroring the same full-overwrite convention
 * `updateMatch` uses for `tags`.
 */
export async function updateSession(
  database: Database,
  tenantId: string,
  sessionId: string,
  patch: {
    date?: number;
    characterTags?: number[];
    summary?: string;
    homework?: HomeworkItem[];
    linkedMatchIds?: string[] | null;
    coachPrivateNotes?: string | null;
  },
): Promise<{ sessionId: string } & TrainingSession> {
  const current = await getSession(database, tenantId, sessionId);

  const next = trainingSessionSchema.parse({
    ...current,
    ...(patch.date !== undefined ? { date: patch.date } : {}),
    ...(patch.characterTags !== undefined ? { characterTags: patch.characterTags } : {}),
    ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
    ...(patch.homework !== undefined ? { homework: patch.homework } : {}),
    ...(patch.linkedMatchIds !== undefined ? { linkedMatchIds: patch.linkedMatchIds } : {}),
    ...(patch.coachPrivateNotes !== undefined
      ? { coachPrivateNotes: patch.coachPrivateNotes }
      : {}),
    lastEditedAt: Date.now(),
  } satisfies TrainingSession);

  await database.ref(`trainingSessions/${tenantId}/${sessionId}`).set(next);
  return { sessionId, ...next };
}

/**
 * Flips one homework item's `done` state in place — a mutable-log toggle,
 * not a separate write path. Throws `NotFoundError` if the session or the
 * item doesn't exist.
 */
export async function toggleHomeworkItem(
  database: Database,
  tenantId: string,
  sessionId: string,
  itemId: string,
  done: boolean,
): Promise<{ sessionId: string } & TrainingSession> {
  const current = await getSession(database, tenantId, sessionId);
  const itemIndex = current.homework.findIndex((item) => item.id === itemId);
  if (itemIndex === -1) {
    throw new NotFoundError(`Homework item ${itemId} not found on session ${sessionId}`);
  }

  const nextHomework = current.homework.map((item, index) =>
    index === itemIndex ? { ...item, done } : item,
  );

  const next = trainingSessionSchema.parse({
    ...current,
    homework: nextHomework,
    lastEditedAt: Date.now(),
  } satisfies TrainingSession);

  await database.ref(`trainingSessions/${tenantId}/${sessionId}`).set(next);
  return { sessionId, ...next };
}
