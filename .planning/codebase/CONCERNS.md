# Codebase Concerns

**Analysis Date:** 2026-07-09

## Tech Debt

**GSP/MMR Model Uncertainties:**

- Issue: The hidden-MMR reverse-engineered model in `packages/shared/src/gspMmr.ts` contains unresolved exact integer quantization rules. The delta system (K=20 Elo equivalent) reproduces 16/28 observed rows exactly with simple rounding; systematic sub-rounding at band edges is UNRESOLVED.
- Files: `packages/shared/src/gspMmr.ts` (lines 28-34), `packages/shared/src/gspMmr.test.ts`
- Impact: Single-point imprecision in MMR predictions could cascade into inaccurate "Road to Elite" calculations and misleading matchup projections for users. Tail slopes (top MMR > 1400, bottom MMR < 600) are marked approximate and drift slowly, reducing precision at rank extremes.
- Fix approach: Community reverse-engineering via larger crowd-sourced datasets may eventually resolve the quantization rule; maintain current approximation with documented uncertainty bands and consider periodic model re-validation against live data.

**Parry.gg Client .d.ts Breakage:**

- Issue: `@parry-gg/client@1.0.12` ships broken TypeScript definitions under `NodeNext` module resolution (module doubles paths), fixed only via pnpm patch in `patches/@parry-gg__client@1.0.12.patch`.
- Files: `patches/@parry-gg__client@1.0.12.patch`, `apps/api/src/parrygg/client.ts`, `pnpm-workspace.yaml`
- Impact: Build breaks on `pnpm install` or patch loss; patch must be maintained until upstream fixes or dependency updates. Fragile upgrade path — any version bump of parry.gg client requires patch re-validation.
- Fix approach: Track upstream parry.gg client releases; test each new version for TypeScript emit; remove patch when upstream publishes .d.ts fix or evaluate alternative gRPC-Web clients.

**Instance-Local Cache Without Distribution Guarantees:**

- Issue: `GspLiveService` (lines 31-74 in `apps/api/src/gspLive/service.ts`), `ScoutCache` (`apps/api/src/startgg/scout.ts` lines 375–410), and `ParryScoutCache` (`apps/api/src/parrygg/scout.ts` lines 405–450) use in-memory per-instance caches with no cross-instance coordination. Multiple Cloud Run replicas independently fetch and cache; stale upstream failures only affect one replica's backoff window.
- Files: `apps/api/src/gspLive/service.ts`, `apps/api/src/startgg/scout.ts`, `apps/api/src/parrygg/scout.ts`, `apps/api/src/groups/groups.ts`
- Impact: No guarantee all instances serve identical cached data (GSP thresholds, scout reports, group leaderboards) during fetch storms or upstream outages. Eventual consistency across replicas is undefined; one user may see a fresh reading while another sees stale.
- Fix approach: For frequently-accessed, low-volatility data (GSP live), consider RTDB as the single cache backend (already done for GSP, needs evaluation for scout/group caches); for truly per-instance caches, document the eventual-consistency behavior and add cache-age headers so clients can retry or merge stale results.

**RTDB Null Stripping Hazard:**

- Issue: Firebase RTDB silently deletes keys when set to `null`, yet TypeScript schemas (e.g., `gspSettingsSchema` in `packages/shared/src/index.ts`) use `.nullish()` to allow null values. Conditional-spread writes prevent this, but post-deletion, schema validation fails on missing `optional` fields if not handled correctly.
- Files: `apps/api/src/services/rtdb.ts` (lines 148–161, 207–218, 344–351), production-gap checklist (docs/smash-tracker-handoff.md), `packages/shared/src/index.ts` (all `nullish()` patterns)
- Impact: A single unhandled null write nukes a record key; reads against a schema expecting that key will fail validation. List routes already use `safeParse+skip` (line 409–412 in rtdb.ts), but new endpoints risk 500s on corrupt/missing fields.
- Fix approach: Enforce conditional-spread pattern in all writes; add safeParse+skip to any new list endpoints; consider RTDB schema migration tooling to audit existing keys for orphaned nulls.

**Undefined Query Retry Semantics on Transient 4xx:**

- Issue: Web layer (`apps/web/src/lib/queryClient.ts` lines 21–26) correctly blocks retry on 4xx errors, but the decision rule assumes all 4xx are deterministic (bad input, missing auth). Transient issues like 429 Rate Limit (Anthropic, start.gg) return 429 and are NOT retried, blocking the user's action permanently instead of backing off.
- Files: `apps/web/src/lib/queryClient.ts`, `apps/api/src/routes/reports.ts` (lines 245–256 for start.gg 429, 289–297 for Anthropic RateLimit)
- Impact: User clicks "Generate Report", hits Anthropic rate limit (429), web shows error and does not retry. Retry logic is only in the route handler itself (rate limit exceptions returned as API errors 429), but the web layer treats it as fatal. Users must manually retry; no exponential backoff at client level.
- Fix approach: Distinguish transient 4xx (429, 503-passed-through-as-4xx) from deterministic 4xx (401, 400, 404); implement client-side exponential backoff for 429 separately, or escalate retry logic to the mutation layer (e.g., `useMutation({ retry: shouldRetryMutation })`).

## Known Bugs

**Start.gg OAuth Redirect URI Drift:**

- Symptoms: Login callback (`apps/api/src/routes/startgg.ts` line ~40) uses `STARTGG_REDIRECT_URI` env var; if OAuth config on start.gg dev portal points to old domain but env var holds new domain, redirect_uri_mismatch occurs and login fails silently.
- Files: `apps/api/src/routes/startgg.ts`, env var `STARTGG_REDIRECT_URI`, start.gg dev portal OAuth config
- Trigger: Deploy to new domain without updating start.gg portal; user clicks "Login with start.gg", lands on callback URL mismatch.
- Workaround: Verify start.gg OAuth config matches `STARTGG_REDIRECT_URI` env var before every login-related deploy; update both in lockstep (noted in production-gap checklist).

**GSP Threshold Fetch Failure Cascade:**

- Symptoms: If `gsptiers.com` is down during app startup (before any cached `gspLive` exists), the lazy-refresh in `GspLiveService.get()` (line 39–73) returns `null`. Subsequent GSP comparison logic that assumes a valid elite/max threshold could divide by zero or produce nonsense rankings.
- Files: `apps/api/src/gspLive/service.ts`, `apps/web/src/pages/Gsp/GspPage.tsx` (or wherever elite threshold is used)
- Trigger: App redeploy, gsptiers.com offline, no cached reading in RTDB yet.
- Workaround: Check for `null` in GSP page; do not display elite-threshold-dependent UI until a value is available; document that GSP page is unavailable if upstream is down (graceful degradation).

**Match Time Preservation on Edit:**

- Symptoms: `updateMatch` in `apps/api/src/services/rtdb.ts` (line 202) preserves the original `time` field to prevent re-ordering of match history. If a user edits a match's game facts AND the time value is later re-stamped (bug in a future update), the match will silently re-order, corrupting GSP trend curves and form analysis.
- Files: `apps/api/src/services/rtdb.ts` (lines 195–230), match edit route `apps/api/src/routes/matches.ts`
- Trigger: Future code change that accidentally calls `Date.now()` during edit, or schema migration that re-stamps times.
- Workaround: Add integration test that verifies match time is never updated on PATCH; document the invariant in match schema comments.

## Security Considerations

**Billing Webhook HMAC Validation:**

- Risk: Stripe webhook handler in `apps/api/src/routes/billing.ts` validates HMAC signature, but raw-body parser is scoped to a nested plugin. If the plugin is misconfigured or the raw body is lost before validation, the signature check could be bypassed, allowing forged credit-add events.
- Files: `apps/api/src/routes/billing.ts`, `apps/api/src/plugins/rawBodyParser.ts`
- Current mitigation: Raw-body scoping is explicit (plugin lifecycle); tests verify HMAC rejection on bad signatures (line 254–258 in billing.test.ts).
- Recommendations: Add integration test that confirms raw-body parser is invoked before HMAC validation; document the plugin ordering in app.ts to prevent future developer errors; consider reading Stripe webhook IDs to idempotency-dedupe events.

**OAuth State Token Leakage:**

- Risk: `STARTGG_STATE_SECRET` (env var) is used to sign OAuth state tokens in `apps/api/src/startgg/oauth.ts`. If the secret is committed to git, checked into logs, or exposed in Cloud Run env vars, an attacker can forge valid state tokens and hijack login flows.
- Files: `apps/api/src/startgg/oauth.ts`, env vars, Cloud Run service config
- Current mitigation: State secret is untracked (stored in untracked .env files); production key rotation runbook was delivered 2026-07-08.
- Recommendations: Rotate `STARTGG_STATE_SECRET` monthly; audit Cloud Run secrets export history; use Secret Manager rather than plain env vars for sensitive values; confirm state token rotation on each deployment.

**Parry.gg Bio-Code Verification Without Rate Limit:**

- Risk: `parrygg/verificationCode.ts` (lines 19–26) generates `ST-XXXXXX` codes with a 10-minute TTL. The endpoint that issues codes is not rate-limited; an attacker could brute-force the code space or spam the user's Parry.gg profile with requests. Parry.gg GetUser is called to verify the code is in the bio, which is rate-limited, but issuance is not.
- Files: `apps/api/src/parrygg/verificationCode.ts`, `apps/api/src/routes/parryggAuth.ts` (POST /auth/parrygg/login/start)
- Current mitigation: 10-minute TTL limits old codes; verification requires reading user bio (rate-limited by Parry.gg gRPC service).
- Recommendations: Add per-IP rate limiting to the code-issuance endpoint (e.g., 1 code per user per minute, max 5 per hour per IP); log suspicious verification attempts; consider TOTP or SMS verification as an alternative.

**RTDB Deny-All Rules Bypass via API:**

- Risk: Database rules are set to deny-all (production-gap checklist); all data access flows through the API. If an API route handler has insufficient auth checks or a logic bug, users can read/write data they shouldn't. No client-side rules provide defense-in-depth.
- Files: `database.rules.json`, all route handlers in `apps/api/src/routes/`
- Current mitigation: Route handlers check Firebase auth tokens (via `getFirebaseAuth` middleware); UID is extracted and compared against resource ownership (e.g., match ownership checked before update). Tests validate auth enforcement.
- Recommendations: Add audit logging to all write endpoints (match create/update/delete, report generation, billing); consider a per-user API key or session token for sensitive operations; review each route handler for UID/ownership validation before merge.

## Performance Bottlenecks

**Scout Report Generation Token Cost:**

- Problem: Reports use Anthropic Claude Opus 4.8 with extended thinking; a single report can consume 10,000+ tokens, costing ~$0.25 in API fees. With user credit packs ($5 for 5 reports), margin is thin and each failure (e.g., refusal) wastes credit without refund.
- Files: `apps/api/src/reports/generate.ts` (line ~102), `apps/api/src/routes/reports.ts` (lines 245–307 for error handling)
- Cause: Full match history + H2H + per-character records + matchup advisor = large payload to ground analysis; extended thinking adds introspection overhead.
- Improvement path: Implement payload compression (remove full game list from scout report payload — already done per line 63–68 in generate.ts); cache advisor output; consider model inference caching or switching to a smaller model for simple scenarios.

**Bundle Size at 1.2MB:**

- Problem: Main app bundle (`apps/web/dist/assets/index-kZaFvEaB.js`) is 719KB, with chart dependencies (~170KB chartTheme chunk). i18n files (ja, fr, pt, es, de) add 40–50KB each. Total gzipped transfer is substantial for low-bandwidth users.
- Files: `apps/web/vite.config.ts`, `apps/web/src/main.tsx`
- Cause: All pages bundled together; no code splitting beyond route chunks; full chart.js library included for all pages (some users may never view trends).
- Improvement path: Split chart.js into dynamic import on Trends page; lazy-load i18n namespaces per route; tree-shake unused Tailwind utilities; evaluate bundle analysis tool (Rollup plugin) to identify other dead code.

**Group Leaderboard Computation Cache Invalidation:**

- Problem: `apps/api/src/groups/groups.ts` (lines 358–403) caches leaderboard for ~5 minutes. If a user updates their match record, the group leaderboard remains stale until cache expires or is manually evicted. For large groups with frequent updates, users see outdated rankings.
- Files: `apps/api/src/groups/groups.ts` (GroupLeaderboardCache), routes that invalidate cache (e.g., match create/update should call `evict`)
- Cause: In-memory cache trades consistency for compute speed; no pub/sub or event propagation when member data changes.
- Improvement path: Reduce cache TTL for active groups (query membership count, set TTL dynamically); add cache invalidation hook to match mutation routes; consider a background job that updates group leaderboards incrementally rather than full recomputation.

## Fragile Areas

**Complex Alias Resolution Logic:**

- Files: `apps/api/src/services/rtdb.ts` (lines 312–321 resolveCanonical, lines 290–301 setOpponentAlias)
- Why fragile: The alias map is stored as a flat key-value object with no referential integrity. `resolveCanonical` follows chains until a fixed point; if a cycle is introduced (e.g., A -> B -> C -> A), the loop detector (`seen` set) prevents infinite loops but the chain is unresolved. New aliases can be added while others are being resolved, creating race conditions in multi-instance deployments.
- Safe modification: Always call `listOpponentAliases` before any write to get the latest state; document that alias merges are not atomic across multiple instances; add a migration tool to detect and break cycles in production data.
- Test coverage: `sync.test.ts` (normalizeOpponentTag, gamesFromSet) covers sync integration but not alias race conditions; add concurrency tests that call `setOpponentAlias` in parallel and verify no cycles form.

**Match Sync Idempotency Keys:**

- Files: `apps/api/src/startgg/sync.ts`, `apps/api/src/parrygg/sync.ts`, match records with `source` and `externalId` fields
- Why fragile: Synced matches use `source` (e.g., 'start.gg') and `externalId` (e.g., 'sgg-12345-g1') to uniquely identify a remote match. If a sync run crashes mid-way, a retry could re-insert the same match. The idempotency check (match already exists with same externalId) is not transactional — a race between two replicas could create duplicates.
- Safe modification: Ensure sync always queries for existing matches before inserting; use RTDB transactions for critical writes; add deduplication in the list route (safeParse+skip) so one corrupt record doesn't 500 the whole page.
- Test coverage: Sync tests create dummy matches but don't simulate concurrency or partial failures; add a chaos test that kills sync mid-run and verifies no duplicates appear on retry.

**GSP Reading Immutability Contract:**

- Files: `apps/api/src/routes/gspReadings.ts`, `apps/api/src/services/rtdb.ts` (updateGspReading, lines 439–454)
- Why fragile: `updateGspReading` allows editing only the GSP value; `time` and `fighter_id` are immutable (enforced in code, not schema). If a developer accidentally allows editing `time`, the GSP series will be corrupted (re-ordering breaks trends). No UI prevents editing `fighter_id`, but code rejects it — inconsistency between API and UI contract.
- Safe modification: Document the immutability contract in the schema itself (e.g., JSDoc or separate `ImmutableGspReading` type); add an integration test that verifies `fighter_id` and `time` cannot be changed even if the request includes them; consider removing those fields from the update input schema entirely.
- Test coverage: `gspReadings.test.ts` doesn't test immutability enforcement; add test cases that attempt to modify `time` or `fighter_id` and confirm they're ignored.

## Scaling Limits

**In-Memory Scout Caches on Single-Instance Colocation:**

- Current capacity: `ScoutCache` holds up to ~100 entries (LRU with 30-minute TTL, capped per line 375–410 in scout.ts); parrygg scout cache holds similarly. With multiple Cloud Run replicas, each maintains its own cache.
- Limit: If a viral scouting query (e.g., "top 100 players in a tournament") hits, each replica independently fetches all 100 players and caches them separately. No cross-replica deduplication; upstream rate limit (80 req/60s for start.gg) can be hit by coordinated requests across replicas.
- Scaling path: Move cache to a shared backend (Redis, Memcached, or RTDB); implement a distributed rate limiter (e.g., using RTDB transactions or an external service); add cache reuse across replicas to reduce upstream load.

**RTDB Write Contention on Sync and Billing:**

- Current capacity: Sync can run on multiple events (user-triggered, webhook, scheduled); billing webhook updates credits atomically via RTDB transaction. No queueing or throttling on concurrent writes.
- Limit: If two replicas simultaneously sync the same user's matches and one updates the opponent set while the other does, writes could interleave and lose data (RTDB transactions help but only within a single ref path). Billing transactions serialize but heavy concurrency may cause transaction retries.
- Scaling path: Implement a job queue (e.g., Cloud Tasks) for sync so only one replica processes a user at a time; batch billing updates into hourly settlement rather than immediate transactions; monitor RTDB transaction retry rates and scale horizontally with eventual consistency.

**Firebase Authentication Token Generation Bottleneck:**

- Current capacity: OAuth login callback creates a custom Firebase token via `createCustomToken` (start.gg, parry.gg flows). Each token creation hits Firebase IAM permissions check. No caching; production incident (2026-07-08) occurred when IAM rate limit was hit during a login surge.
- Limit: Burst login traffic (e.g., tournament day) can overwhelm IAM and cause login timeouts (501 errors, see handoff notes).
- Scaling path: Implement OAuth token caching (short-lived, e.g., 5 minutes) so re-logins don't re-hit IAM; switch to session-based auth (issue a session cookie instead of calling createCustomToken every time); batch custom token creation or use a Cloud Function with higher concurrency limits.

## Dependencies at Risk

**@parry-gg/client@1.0.12 Broken TypeScript Definitions:**

- Risk: Package ships .d.ts files that don't work under NodeNext module resolution (see patches section). Upstream appears unmaintained (last release 2024; no recent updates). TypeScript version bump (e.g., TS 6.0) might surface new incompatibilities.
- Impact: Build will fail if patch is lost or if TypeScript version changes; upgrade path is blocked until upstream fixes or we fork.
- Migration plan: Monitor @parry-gg/client releases; test each new version; evaluate alternative gRPC-Web clients (e.g., @grpc-web/grpc-web, ts-proto) if parry.gg remains unmaintained.

**Firebase Admin SDK Version Pinning:**

- Risk: `firebase-admin` is not explicitly pinned in `package.json`; pnpm-lock.yaml holds the version. Future `pnpm install --latest` could pull a breaking API change (e.g., database ref signature, error types).
- Impact: Sync operations, match writes, all backend work depends on Admin SDK; a silent upgrade could break production.
- Migration plan: Pin `firebase-admin` to a major version (e.g., `^13.0.0`); test each new major release thoroughly before upgrading; document any API changes in STACK.md.

**Anthropic SDK Rate Limit Handling:**

- Risk: `@anthropic-ai/sdk` version drift could change error types or message format (e.g., `Anthropic.RateLimitError` might be renamed). Reports.ts catches specific error types (line 289–297); if SDK structure changes, rate-limit detection breaks.
- Impact: Rate limit errors would no longer be caught as 429; instead, they'd bubble as generic API errors (500) and block the user.
- Migration plan: Version-pin @anthropic-ai/sdk; test SDK updates in staging with dummy rate-limit scenarios; use error instance checks rather than string matching (already done correctly).

## Missing Critical Features

**No Automatic Retry Loop for Long-Running Operations:**

- Problem: Report generation can run past 60 seconds (blocked by Hosting rewrite, already bypassed via direct URL). If Cloud Run times out at 300s, the report is lost and the user must manually retry. No background retry or resumption.
- Blocks: Multi-minute AI operations; streaming or iterative analysis that requires multiple API calls.
- Suggested solution: Implement a job queue (Cloud Tasks) for report generation; store job state in RTDB; allow user to check status and resume if interrupted.

**No Cross-Shard Coordination for Leaderboard Cache:**

- Problem: Group leaderboards are computed per-request and cached per-instance. With global leaderboard boards (across multiple groups), there's no rollup; users see incomplete rankings.
- Blocks: Tournament-wide or global leaderboards; real-time rankings dashboard.
- Suggested solution: Compute and cache rollups in a dedicated background service; use RTDB transactions to ensure consistency across group updates.

**No Audit Trail for Data Mutations:**

- Problem: Match creates, edits, deletes, alias merges, and billing events are not logged to an audit table. If a user's data is corrupted, there's no recovery trail.
- Blocks: Compliance, fraud investigation, recovery of accidentally deleted data.
- Suggested solution: Add an `auditLog/{uid}` RTDB path or Firestore collection; log all mutations with timestamp, operation, actor, and delta; retain for 90 days.

## Test Coverage Gaps

**No Concurrency Tests for Alias Resolution:**

- What's not tested: Parallel `setOpponentAlias` calls that update the same or related aliases; race conditions in `resolveCanonical` when the map changes mid-resolution.
- Files: `apps/api/src/services/rtdb.ts`, tests missing from `apps/api/src/routes/opponentAliases.test.ts` or unit tests for `RtdbService`.
- Risk: In production, concurrent updates from multiple instances could create cycles or lose updates silently.
- Priority: High — aliases are mutable and user-facing; a corrupted alias map breaks scouting and statistics aggregation.

**No Chaos Tests for Sync Idempotency:**

- What's not tested: Sync process killed mid-run (e.g., Cloud Run instance eviction); restart should not create duplicate matches or lose partial sync state.
- Files: `apps/api/src/startgg/sync.test.ts`, `apps/api/src/parrygg/sync.test.ts`
- Risk: If a sync crashes and leaves RTDB in an inconsistent state, a retry could introduce duplicates or orphaned records.
- Priority: High — sync is a critical user workflow; duplication could corrupt statistics.

**No Rate-Limit Simulation for Billing Webhook:**

- What's not tested: Stripe webhook endpoint under concurrent requests; queueing or backpressure behavior if Stripe retries due to slow processing.
- Files: `apps/api/src/routes/billing.test.ts`
- Risk: If the webhook endpoint is too slow, Stripe could mark it as failing and stop retrying, causing missed credit purchases.
- Priority: Medium — affects monetization but Stripe's retry logic is robust.

**No End-to-End GSP Threshold Fetch Failure Scenario:**

- What's not tested: App startup with `gsptiers.com` offline; GSP page behavior when elite/max threshold is `null`; cache behavior after upstream recovers.
- Files: `apps/api/src/gspLive/service.test.ts` (or missing), `apps/web/src/pages/Gsp/GspPage.test.tsx`
- Risk: Users see broken GSP page or invalid rankings if upstream is down.
- Priority: Medium — graceful degradation is documented but not tested.

---

_Concerns audit: 2026-07-09_
