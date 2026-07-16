/**
 * Phase 6 (Anonymous Share Experience & Discord Unfurls): a small, generic,
 * per-Cloud-Run-instance in-memory TTL cache — deliberately NOT modeled on
 * `GspLiveService` (`apps/api/src/gspLive/service.ts`), whose "cache" is a
 * write-through to Firebase RTDB (`this.database.ref('gspLive').get()/.set()`).
 * That backend exists to survive across Cloud Run instances/restarts and to
 * bound upstream traffic to a few requests per day — the wrong properties for
 * this phase's shell-HTML and OG-PNG caches, which are per-token,
 * high-cardinality, and must respect revocation quickly.
 *
 * ONLY rendered artifacts (the fetched SPA shell string, generated OG PNG
 * bytes, fetched sprite buffers) are ever cached here — NEVER a share
 * token's validity/revocation state. `RtdbService.getShareByToken` always
 * runs uncached, on every request, so a revoke takes effect the moment its
 * TTL-cached rendered artifact expires (a few minutes) rather than never.
 * See RESEARCH.md Pattern 1 / Pitfall 2 / Pitfall 4.
 */
interface Entry<T> {
  value: T;
  expiresAt: number;
}

export interface TtlCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  /** Drops every entry. Exists for test isolation — module-level caches otherwise persist across tests in a file, silently short-circuiting failure-path tests onto the cached happy path. */
  clear(): void;
}

export function createTtlCache<T>(ttlMs: number): TtlCache<T> {
  const store = new Map<string, Entry<T>>();
  return {
    get(key: string): T | undefined {
      const entry = store.get(key);
      if (!entry || entry.expiresAt < Date.now()) return undefined;
      return entry.value;
    },
    set(key: string, value: T): void {
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
    },
    clear(): void {
      store.clear();
    },
  };
}
