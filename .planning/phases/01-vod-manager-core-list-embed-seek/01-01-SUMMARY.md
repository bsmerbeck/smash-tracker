---
phase: 01-vod-manager-core-list-embed-seek
plan: 01
subsystem: ui
tags: [typescript, vite, csp, youtube, twitch, vod]

# Dependency graph
requires: []
provides:
  - 'detectVodProvider(url) + VodProvider discriminated union in apps/web/src/lib/vod.ts — video-id/provider extractor for YouTube (long + short form) and Twitch VODs'
  - 'Scoped Content-Security-Policy meta tag in apps/web/index.html permitting YouTube/Twitch framing + script loading in production'
affects: [01-02, 01-03, 01-04]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - 'detectVodProvider co-located in lib/vod.ts alongside vodDeepLink — one source of truth for host/ID parsing shared by both the fallback-link path and the future player-construction path'
    - 'CSP meta tag in index.html (build copies verbatim to dist/index.html and dist/spa.html) rather than a server-level header'

key-files:
  created: []
  modified:
    - apps/web/src/lib/vod.ts
    - apps/web/src/lib/vod.test.ts
    - apps/web/index.html

key-decisions:
  - "Added detectVodProvider tests to the existing apps/web/src/lib/vod.test.ts file (which already existed with vodDeepLink/formatTimestamp/parseTimestamp coverage) rather than creating a separate file, to match the file's established relative-import convention (./vod) and avoid duplicate test setup"

patterns-established:
  - "New provider-ID-extraction utilities reuse the existing exact-match host allowlist Sets (YOUTUBE_HOSTS/YOUTUBE_SHORT_HOSTS/TWITCH_HOSTS) rather than re-deriving looser checks — required by PITFALLS.md Security Mistakes and the plan's threat_model (T-01-01)"

requirements-completed: [PLAY-01, PLAY-02, PLAY-03]

coverage:
  - id: D1
    description: 'detectVodProvider extracts YouTube (long-form watch?v=, short-form youtu.be) and Twitch (/videos/{id}) video IDs, returning provider:null for unsupported hosts, malformed URLs, and missing/empty IDs'
    requirement: 'PLAY-01'
    verification:
      - kind: unit
        ref: 'apps/web/src/lib/vod.test.ts#detectVodProvider (8 cases)'
        status: pass
    human_judgment: false
  - id: D2
    description: 'index.html ships a scoped, wildcard-free CSP meta tag permitting exactly the four YouTube/Twitch embed origins for frame-src and script-src'
    requirement: 'PLAY-03'
    verification:
      - kind: unit
        ref: 'grep -c ''http-equiv="Content-Security-Policy"'' apps/web/index.html == 1; frame-src/script-src origin + no-wildcard checks'
        status: pass
    human_judgment: true
    rationale: "CSP correctness must be empirically verified against the real deploy target (Firebase preview channel / Cloud Run), not just localhost — flagged explicitly in the plan's threat_model (T-01-03) and PITFALLS.md Pitfall 4 as a plan 01-03 UAT gate, not verifiable via static grep alone"

# Metrics
duration: 12min
completed: 2026-07-09
status: complete
---

# Phase 01 Plan 01: VOD Provider Detection + Scoped CSP Summary

**detectVodProvider video-ID extractor for YouTube/Twitch in lib/vod.ts, plus a scoped Content-Security-Policy meta tag in index.html permitting the four embed origins**

## Performance

- **Duration:** 12 min
- **Started:** 2026-07-09T22:24:07Z
- **Completed:** 2026-07-09T22:29:20Z
- **Tasks:** 2 completed
- **Files modified:** 3 (vod.ts, vod.test.ts, index.html)

## Accomplishments

- `detectVodProvider(url)` co-located in `apps/web/src/lib/vod.ts`, returning a discriminated union (`{provider:'youtube'|'twitch', videoId}` or `{provider:null}`), reusing the existing `YOUTUBE_HOSTS`/`YOUTUBE_SHORT_HOSTS`/`TWITCH_HOSTS` allowlists
- Eight unit tests covering YouTube long/short-form, Twitch VOD, and every rejection case (unsupported host, missing param, malformed URL, live-channel path)
- Scoped `Content-Security-Policy` meta tag added to `apps/web/index.html`, permitting exactly `www.youtube.com`, `www.youtube-nocookie.com`, `player.twitch.tv`, `embed.twitch.tv` for framing and `www.youtube.com`/`embed.twitch.tv` for scripts — no wildcards

## Task Commits

Each task was committed atomically (TDD: test → feat, no refactor needed):

1. **Task 1: Add detectVodProvider + VodProvider to lib/vod.ts (TDD)**
   - `1ac8c71` (test) — eight failing test cases (RED)
   - `dd5134a` (feat) — `detectVodProvider` + `VodProvider` implementation (GREEN)
2. **Task 2: Add scoped CSP meta tag to index.html** - `a22a7e1` (feat)

## Files Created/Modified

- `apps/web/src/lib/vod.ts` - Adds `VodProvider` type + `detectVodProvider(url)`; existing `vodDeepLink`/`formatTimestamp`/`parseTimestamp` untouched
- `apps/web/src/lib/vod.test.ts` - Adds `describe('detectVodProvider', ...)` block (8 cases) to the existing test file
- `apps/web/index.html` - Adds scoped CSP `<meta http-equiv="Content-Security-Policy">` after the viewport meta tag, with an HTML comment flagging real-deploy-target verification as a plan 01-03 UAT gate

## Decisions Made

- Extended the existing `apps/web/src/lib/vod.test.ts` (already present with `vodDeepLink`/`formatTimestamp`/`parseTimestamp` coverage, importing via relative `./vod`) rather than creating a new file, matching the file's established convention instead of introducing a parallel `@/lib/vod`-importing test file for the same module.

## Deviations from Plan

None - plan executed exactly as written. The plan's artifact list mentioned `apps/web/src/lib/vod.test.ts` as if new; it already existed in the worktree with prior test coverage, so this plan extended it in place rather than creating it — not a deviation in behavior or scope, just a pre-existing file the plan's task description anticipated correctly (the `<action>` text says "Write... FIRST" without asserting the file doesn't exist).

## Issues Encountered

`pnpm --filter @smash-tracker/web test` (full suite) reports 67 failing test files due to `@smash-tracker/shared` resolving to a missing `dist/` (pre-existing environment issue in this worktree — `packages/shared` has not been built). This is out of scope per the deviation rules' scope boundary (pre-existing failures unrelated to this plan's files) and does not affect `src/lib/vod.test.ts`, which passes 26/26 (18 existing + 8 new) with zero failures. All 326 tests across the 51 passing test files pass; no regressions were introduced by this plan's changes.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `detectVodProvider` is ready for plan 01-03's player-construction path (`VodPlayer.tsx` / `useVodPlayer.ts` hook) to consume directly for `YT.Player`/`Twitch.Player` ID input.
- CSP meta tag is in place for local/dev testing; **plan 01-03 must empirically verify the CSP (and Twitch's separate `parent` allowlist) against the real Firebase preview channel / Cloud Run deploy** before phase sign-off, per PITFALLS.md Pitfall 4 and this plan's threat_model T-01-03 — flagged in the HTML comment above the meta tag.
- No blockers for downstream plans in this phase.

---

_Phase: 01-vod-manager-core-list-embed-seek_
_Completed: 2026-07-09_

## Self-Check: PASSED

All created/modified files verified present on disk (`apps/web/src/lib/vod.ts`, `apps/web/src/lib/vod.test.ts`, `apps/web/index.html`); all three task commits (`1ac8c71`, `dd5134a`, `a22a7e1`) verified present in `git log`.
