/**
 * Per-browser coach identity for edit-tier share sessions (Phase 8 —
 * Coaching Edit Sessions, COACH-02/03/05): a `crypto.randomUUID()` session
 * id plus a self-declared display name, persisted together in ONE
 * localStorage record. Mirrors `shareReferral.ts`'s / `vodPrefs.ts`'s
 * `smash-tracker.*`-prefixed key, tolerant `parseStored*`, and
 * try/catch-guarded storage calls (Safari private mode / disabled storage
 * must never throw — every exported function here is a no-throw function).
 *
 * No `uuid` npm dependency: this repo has none, and native
 * `crypto.randomUUID()` is dependency-free and available in every evergreen
 * browser (RESEARCH.md's Package Legitimacy Audit).
 *
 * The session id travels in every coach write's request — the POST/PATCH
 * body or the DELETE query param (see `useCoachNotes.ts`) — and server-side
 * ownership is scoped to `coach.sessionId === callerSessionId`, NEVER to the
 * display name (self-declared and unverified by design — T-08-20).
 */

export const COACH_SESSION_STORAGE_KEY = 'smash-tracker.coachSession';

interface StoredCoachSession {
  sessionId: string;
  displayName?: string;
}

/**
 * Parses the persisted coach session record, tolerating missing/malformed
 * localStorage content. Returns `null` for anything that isn't at least a
 * `{ sessionId: string }` shape — never throws. A non-string/empty
 * `displayName` is dropped rather than failing the whole record.
 */
export function parseStoredCoachSession(raw: string | null): StoredCoachSession | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as StoredCoachSession).sessionId !== 'string' ||
      (parsed as StoredCoachSession).sessionId.length === 0
    ) {
      return null;
    }
    const displayName = (parsed as StoredCoachSession).displayName;
    return {
      sessionId: (parsed as StoredCoachSession).sessionId,
      ...(typeof displayName === 'string' && displayName.length > 0 ? { displayName } : {}),
    };
  } catch {
    return null;
  }
}

function readStored(): StoredCoachSession | null {
  if (typeof window === 'undefined') return null;
  try {
    return parseStoredCoachSession(window.localStorage.getItem(COACH_SESSION_STORAGE_KEY));
  } catch {
    return null;
  }
}

function persist(record: StoredCoachSession): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(COACH_SESSION_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Ignore storage failures — the session just won't persist across reloads.
  }
}

/**
 * Returns this browser's coach session id, generating and persisting a
 * fresh `crypto.randomUUID()` the first time it's called (or any time
 * storage is missing/malformed/cleared). Stable across every subsequent
 * call in the same browser — never regenerated once a valid id exists.
 */
export function getOrCreateSessionId(): string {
  const existing = readStored();
  if (existing) {
    return existing.sessionId;
  }
  const sessionId = crypto.randomUUID();
  persist({ sessionId });
  return sessionId;
}

/** Returns the stored display name, or `null` if none has been captured yet. */
export function getStoredDisplayName(): string | null {
  return readStored()?.displayName ?? null;
}

/**
 * Captures the coach's self-declared display name for this browser's
 * session, preserving (or generating, if absent) the session id. Fires once,
 * on the coach's FIRST write attempt (see `ShareViewPage`'s deferred-write
 * name-prompt gate) — every later write reuses the stored name.
 */
export function setDisplayName(name: string): void {
  const sessionId = getOrCreateSessionId();
  const trimmed = name.trim();
  persist({ sessionId, ...(trimmed ? { displayName: trimmed } : {}) });
}
