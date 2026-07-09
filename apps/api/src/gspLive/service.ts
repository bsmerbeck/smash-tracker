import type { Database } from 'firebase-admin/database';
import { gspLiveSchema, gsptiersUpstreamSchema, type GspLive } from '@smash-tracker/shared';

/** Refresh upstream when the cached reading is older than this (~4 fetches/day worst case). */
export const GSP_LIVE_STALE_MS = 6 * 60 * 60 * 1000;

/**
 * After a failed upstream attempt, don't re-try upstream for this long
 * (instance-local): with a stale cache and a down upstream, every incoming
 * request would otherwise re-hit gsptiers.com.
 */
export const GSP_LIVE_FAILURE_BACKOFF_MS = 5 * 60 * 1000;

/** gsptiers.com's own data endpoint — the JSON its client renders from. */
export const GSPTIERS_ENDPOINT = 'https://gsptiers.com/gsp-thingy/gsp';

/** Identifies us to the upstream operator; deliberate low cadence is enforced by the staleness window. */
const USER_AGENT = 'grandfinals.gg threshold sync (+https://grandfinals.gg; bsmerbeck@gmail.com)';

/**
 * V17.1: live elite/max GSP readings, RTDB-cached with lazy refresh.
 *
 * Read path: return the `gspLive` singleton if it's fresher than
 * `GSP_LIVE_STALE_MS`; otherwise fetch gsptiers.com's endpoint, store, and
 * return. On upstream failure the stale cache is served (a few-hours-old
 * reading still beats the static drift anchor); `null` only when there has
 * never been a successful fetch AND upstream is failing. The staleness
 * window — not a scheduler — is what bounds upstream traffic to a few
 * requests per day in total, regardless of user count.
 */
export class GspLiveService {
  private lastFailedAttemptAt = 0;

  constructor(
    private readonly database: Database,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async get(logger?: { warn: (obj: unknown, msg?: string) => void }): Promise<GspLive | null> {
    const snapshot = await this.database.ref('gspLive').get();
    const cached = snapshot.exists() ? gspLiveSchema.safeParse(snapshot.val()) : null;
    const cachedValue = cached?.success ? cached.data : null;

    const now = Date.now();
    if (cachedValue && now - cachedValue.fetchedAt < GSP_LIVE_STALE_MS) {
      return cachedValue;
    }
    if (now - this.lastFailedAttemptAt < GSP_LIVE_FAILURE_BACKOFF_MS) {
      return cachedValue;
    }

    try {
      const response = await this.fetchImpl(GSPTIERS_ENDPOINT, {
        headers: { 'user-agent': USER_AGENT },
      });
      if (!response.ok) {
        throw new Error(`upstream responded ${response.status}`);
      }
      const body = gsptiersUpstreamSchema.parse(await response.json());
      const record: GspLive = {
        elite: Math.round(body.elite),
        max: Math.round(body.max),
        fetchedAt: now,
        source: 'gsptiers.com',
      };
      await this.database.ref('gspLive').set(record);
      return record;
    } catch (err) {
      this.lastFailedAttemptAt = now;
      logger?.warn({ err }, 'gsp live upstream refresh failed; serving stale cache if any');
      return cachedValue;
    }
  }
}
