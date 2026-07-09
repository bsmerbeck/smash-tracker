# smash-tracker (grandfinals.gg) — VOD Manager Overhaul

## What This Is

grandfinals.gg is a free, community-driven SSBU (Super Smash Bros. Ultimate) analytics web app — match tracking, GSP/rating tracking, matchup scouting, and AI-generated scouting reports (the only paid feature, priced to break even). This GSD milestone covers the **VOD Manager overhaul**: taking the existing "attach a VOD + timestamped notes to a match" feature and turning it into a full VOD management experience — a dedicated page for finding, watching, annotating, tagging, and organizing recorded matches into playlists, without hosting any video itself.

## Core Value

A player with a library of recorded sets can find any specific moment across all their VODs in seconds — search/filter to the match, click a timestamp, watch it play right there — and organize their footage (tags, playlists) the way they actually think about their own play.

## Requirements

### Validated

- ✓ Match tracking (manual entry, start.gg sync, parry.gg sync) with alias/opponent canonicalization — existing
- ✓ GSP/MMR tracking, decay-fit projection, live elite/max thresholds from gsptiers.com — existing
- ✓ Glicko rating engine, matchup advisor (UltRank tiers + archetype counters) — existing
- ✓ Scouting (scout-anyone aggregation) + AI scouting reports via Stripe credit packs — existing
- ✓ VOD attach + timestamped notes on a match (`vodUrl` + `vodTimestamps` on `Match`, `apps/web/src/components/vod/VodNotesDialog.tsx`, deep-link helpers in `apps/web/src/lib/vod.ts`) — existing, this milestone builds on top of it
- ✓ i18n (en/es/fr/de/pt/ja) across all authenticated pages — existing
- ✓ Public SEO pages (landing, FAQ, GSP calculator) with prerendering — existing
- ✓ Group leaderboards, stage favorites, tournament pages with bracket-aware sync — existing

### Active

- [ ] **VOD-01**: Dedicated VOD Manager page listing all matches that have a VOD attached
- [ ] **VOD-02**: Filter/sort VOD list by character, opponent, tournament, stage, and recency
- [ ] **VOD-03**: Deep-link from any match row's VOD affordance straight into the VOD Manager with that match's video pre-selected
- [ ] **VOD-04**: Embedded video player for YouTube and Twitch VODs (not just an external open-in-new-tab link)
- [ ] **VOD-05**: Click a timestamp note → player seeks to that point and the note is visually highlighted/selected
- [ ] **VOD-06**: Add, edit, and remove timestamp notes directly from the manager view (not modal-only)
- [ ] **VOD-07**: Edit match details (opponent, character, stage, result, etc.) from within the manager, alongside the player
- [ ] **VOD-08**: Tags on matches and on individual timestamp notes — freeform custom tags plus a set of recommended presets (validated via domain research, e.g. neutral/punish/recovery/edgeguard-style categorization used by FGC VOD review tools)
- [ ] **VOD-09**: Playlists — named groups of VOD matches supporting both organization (grouping/browsing) and sequential playback (play through the list in order)

### Out of Scope

- External/public sharing of playlists or VOD notes (read-only links, etc.) — deferred; this milestone is private-to-account only
- Hosting or transcoding video ourselves — VODs always live on YouTube/Twitch/etc.; we only embed and deep-link
- Video hosts beyond YouTube and Twitch for embedded seekable playback — other hosts (Drive, Streamable, raw files) still get the existing plain-link fallback, not full embed treatment, unless revisited later

## Context

- The existing VOD feature (V7-E) already has the hard data-modeling and deep-link math solved: `packages/shared/src/match.ts` (`vodTimestampSchema`, `vodUrl`/`vodTimestamps` on `matchRecordSchema`, max 20 timestamps per match), `apps/web/src/lib/vod.ts` (`vodDeepLink`, `formatTimestamp`, `parseTimestamp` — already handle YouTube long/short URLs and Twitch VOD URLs). This overhaul reuses that foundation rather than replacing it.
- Current entry points are `VodNotesDialog` (modal, opened from `MatchTable` row icon and `SetTimeline`) — edit-only, no playback. The new manager page needs to either replace, absorb, or coexist with this dialog; exact relationship is a planning-time decision, not a product requirement.
- `EditMatchForm` (`apps/web/src/components/match-form/`) is the existing match-edit component and should be reused/embedded rather than rebuilt for VOD-01/07.
- Tags and playlists are net-new data concepts — no existing schema. Needs new RTDB shapes (likely `matchTags`, `noteTags`, and a `playlists/{uid}` collection) following the app's established conventions (server-stamped timestamps, `.nullish()` + conditional-spread writes per the RTDB null-stripping hazard noted in `.planning/codebase/CONCERNS.md`).
- Full technology stack, architecture, and known concerns are captured in `.planning/codebase/` (mapped 2026-07-09) — see `STACK.md`, `ARCHITECTURE.md`, `INTEGRATIONS.md`, `CONVENTIONS.md`, `TESTING.md`, `CONCERNS.md`, `STRUCTURE.md`.

## Constraints

- **Tech stack**: Must fit the existing pnpm monorepo (packages/shared, apps/api, apps/web) — React 19/Vite/Tailwind v4/shadcn on web, Fastify 5 + firebase-admin on API, Firebase RTDB (deny-all rules, all access via API) for storage.
- **No video hosting**: Embedding/deep-linking only — never store or proxy actual video bytes.
- **RTDB null-stripping**: Any new schema (tags, playlists) must follow the conditional-spread-write + `.nullish()` pattern already established, per `CONCERNS.md`.
- **i18n**: New UI strings must ship across all 6 locales (en/es/fr/de/pt/ja) per the established convention (plural `_one`/`_other` keys, provider names untranslated, etc. — see `.planning/codebase/CONVENTIONS.md`).
- **Solo maintainer**: One developer (bsmerbeck) shipping via Fable-direct or Sonnet worktree-agent PRs; production-gap checklist (documented in `docs/smash-tracker-handoff.md`) must be checked in every phase brief.

## Key Decisions

| Decision                                                       | Rationale                                                                                                                                              | Outcome   |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| Embed YouTube + Twitch only (click-to-seek)                    | Covers the vast majority of FGC VOD hosts; other hosts keep the existing plain-link fallback                                                           | — Pending |
| Tags apply to both matches and individual timestamp notes      | Matches get browse/filter tags ("vs Fox", "Grand Finals"); notes get situational tags ("neutral", "punish") — covers both use cases the user described | — Pending |
| Playlists support both organization and sequential playback    | User wants named groupings AND a "watch through in order" mode, not just one or the other                                                              | — Pending |
| Private-only for this milestone (no sharing links)             | Keeps scope contained; sharing is a distinct feature with its own privacy/auth surface — explicitly deferred, not rejected                             | — Pending |
| Recommended tag presets come from domain research, not guessed | User explicitly asked to research FGC/VOD-review tagging conventions before locking a preset list                                                      | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):

1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):

1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---

_Last updated: 2026-07-09 after initialization_
