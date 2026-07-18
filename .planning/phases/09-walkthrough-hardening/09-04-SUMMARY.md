---
phase: 09-walkthrough-hardening
plan: 04
subsystem: ui
tags: [react, tanstack-query, i18n, vod-manager, share-management]

requires:
  - phase: 09-walkthrough-hardening
    provides: "Plan 02's POST /api/vod-shares/bulk endpoint, loosened active-delete (no 409-while-active), bulkShareRequestSchema/bulkShareResponseSchema shared types"
provides:
  - 'api.vodShares.bulk client method + useBulkVodShares hook (one mutation, one vodSharesQueryKey invalidation)'
  - 'ShareRow active-row Delete with honest one-confirm copy, plus selectionMode/selected/onToggleSelected props and a native checkbox'
  - 'MySharesDialog selection mode: per-row checkboxes, select-all, live plural-aware count, bulk Revoke/Delete with one dialog-level confirm'
  - 'i18n keys x6 for all new/changed FB-03 strings'
affects: [vod-manager, share-management]

tech-stack:
  added: []
  patterns:
    - "Bulk mutation hooks mirror single-item mutation hooks exactly (mutationFn + one invalidateQueries in onSuccess) — useBulkVodShares copies useRevokeVodShare's shape"
    - 'Selection state (Set<string>) owned by the dialog, not the row — ShareRow stays a controlled/presentational component for selectionMode/selected/onToggleSelected'
    - 'Bulk confirm reuses existing single-row confirm-action copy (revokeConfirmAction/deleteConfirmAction) to keep the AlertDialogAction text distinct from the still-visible toolbar trigger button of the same name'

key-files:
  created: []
  modified:
    - apps/web/src/lib/api.ts
    - apps/web/src/hooks/useVodShares.ts
    - apps/web/src/pages/VodManager/components/ShareRow.tsx
    - apps/web/src/pages/VodManager/components/ShareRow.test.tsx
    - apps/web/src/pages/VodManager/MySharesDialog.tsx
    - apps/web/src/pages/VodManager/MySharesDialog.test.tsx
    - apps/web/src/i18n/locales/en.json
    - apps/web/src/i18n/locales/es.json
    - apps/web/src/i18n/locales/fr.json
    - apps/web/src/i18n/locales/de.json
    - apps/web/src/i18n/locales/pt.json
    - apps/web/src/i18n/locales/ja.json

key-decisions:
  - 'Active-row Delete reuses the existing useDeleteVodShare mutation and confirmDelete-shaped handler verbatim — only the confirm copy and dialog-open state (confirmingActiveDelete) differ from the revoked-row Delete, since Plan 02 already dropped the 409-while-active guard server-side.'
  - "Bulk AlertDialogAction confirm button text reuses revokeConfirmAction ('Revoke link') / deleteConfirmAction ('Remove') rather than the toolbar trigger's short 'Revoke'/'Delete' label, to keep the two buttons textually distinct while both are visible in the DOM."
  - "Selection is per-row-agnostic of status — active and revoked rows are both selectable/bulk-actionable; the server's bulk endpoint (Plan 02) reports skipped counts for no-op actions (e.g. re-revoking an already-revoked share) rather than the client special-casing eligibility."

patterns-established:
  - 'Bulk action UI pattern: dialog owns Set<id> selection state, passes selectionMode/selected/onToggleSelected down to list-item components, and opens exactly one confirm dialog keyed by a pending-action enum rather than per-row dialogs.'

requirements-completed: [FB-03]

coverage:
  - id: D1
    description: 'An ACTIVE share row gets a one-click Delete (Trash2 + one honest confirm) that fully removes the link without a forced revoke-then-delete chain; Revoke and Copy stay unchanged on active rows'
    requirement: FB-03
    verification:
      - kind: unit
        ref: 'apps/web/src/pages/VodManager/components/ShareRow.test.tsx#ShareRow active-row Delete (FB-03) > renders a Delete button on an active row and confirming it deletes in one click'
        status: pass
      - kind: unit
        ref: 'apps/web/src/pages/VodManager/components/ShareRow.test.tsx#ShareRow active-row Delete (FB-03) > an expired row does not get the active-row Delete'
        status: pass
      - kind: unit
        ref: 'apps/web/src/pages/VodManager/components/ShareRow.test.tsx#ShareRow active-row Delete (FB-03) > a revoked row keeps its existing revoked-only Delete, not the active-row Delete'
        status: pass
    human_judgment: false
  - id: D2
    description: 'Multiple shares can be multi-selected (per-row checkbox + select-all) and bulk-revoked or bulk-deleted in ONE confirmed action that summarizes the count per action'
    requirement: FB-03
    verification:
      - kind: unit
        ref: 'apps/web/src/pages/VodManager/MySharesDialog.test.tsx#MySharesDialog selection mode + bulk actions (FB-03) > entering selection mode reveals per-row checkboxes, select-all, and a live count'
        status: pass
      - kind: unit
        ref: 'apps/web/src/pages/VodManager/MySharesDialog.test.tsx#MySharesDialog selection mode + bulk actions (FB-03) > selecting two shares and confirming bulk Revoke fires ONE mutation with both ids, then clears selection'
        status: pass
      - kind: unit
        ref: 'apps/web/src/pages/VodManager/MySharesDialog.test.tsx#MySharesDialog selection mode + bulk actions (FB-03) > bulk Delete opens its own count-summarizing confirm and fires the delete action'
        status: pass
      - kind: unit
        ref: 'apps/web/src/pages/VodManager/MySharesDialog.test.tsx#MySharesDialog selection mode + bulk actions (FB-03) > leaving selection mode via Cancel clears the selection'
        status: pass
    human_judgment: false
  - id: D3
    description: 'A bulk action is ONE mutation and ONE list refetch (single invalidation of vodSharesQueryKey), not N sequential calls'
    requirement: FB-03
    verification:
      - kind: unit
        ref: 'apps/web/src/pages/VodManager/MySharesDialog.test.tsx#MySharesDialog selection mode + bulk actions (FB-03) > selecting two shares and confirming bulk Revoke fires ONE mutation with both ids, then clears selection (asserts bulkVodShares called exactly once)'
        status: pass
    human_judgment: false
  - id: D4
    description: 'All new/changed strings ship across en/es/fr/de/pt/ja with plural _one/_other keys where a count appears'
    requirement: FB-03
    verification:
      - kind: other
        ref: 'grep -l deleteActiveConfirmDescription across all 6 locale files returns 6; grep -l selectionCount_other across all 6 locale files returns 6; node JSON.parse validation of all 6 locale files exits 0; key-set parity check (vodManager.shares namespace) confirms identical structure across all 6 locales'
        status: pass
    human_judgment: false

duration: 13min
completed: 2026-07-18
status: complete
---

# Phase 09 Plan 04: FB-03 My Shares Overhaul (web) Summary

**One-click active-row Delete plus a dialog-level multi-select bulk Revoke/Delete (one mutation, one refetch) for the My Shares manage list, shipped across all 6 locales.**

## Performance

- **Duration:** ~13 min
- **Started:** 2026-07-18T09:58:12-04:00 (worktree base)
- **Completed:** 2026-07-18T10:10:58-04:00
- **Tasks:** 2/2 completed
- **Files modified:** 12

## Accomplishments

- `api.vodShares.bulk` + `useBulkVodShares` — a single mutation hook (mirroring `useRevokeVodShare`'s shape) that POSTs `{ action, shareIds }` to `/api/vod-shares/bulk` and invalidates `vodSharesQueryKey` exactly once, using Plan 02's `bulkShareRequestSchema`/`bulkShareResponseSchema` and the loosened active-delete.
- `ShareRow` active (non-revoked, non-expired) rows now render Copy + Revoke + a new Delete action with an honest one-confirm dialog — no forced revoke-then-delete chain. The revoked-row Delete and per-row Copy/Revoke are unchanged.
- `ShareRow` gained `selectionMode`/`selected`/`onToggleSelected` props and a prop-gated native checkbox, keeping it a controlled/presentational component driven entirely by `MySharesDialog`.
- `MySharesDialog` gained a Select/Cancel toggle, select-all, a live plural-aware selection count, and bulk Revoke/Delete buttons that open exactly ONE dialog-level `AlertDialog` confirm (summarizing the selected count for that action) and fire `useBulkVodShares` exactly once — never a per-id loop.
- 18 new i18n keys shipped across en/es/fr/de/pt/ja under `vodManager.shares`, with `_one`/`_other` plural pairs for every count-bearing string; key-set parity verified identical across all 6 locales.

## Task Commits

Each task was committed atomically:

1. **Task 1: FB-03 client + per-row active Delete** - `0f42a02` (feat)
2. **Task 2: MySharesDialog selection mode + bulk revoke/delete** - `2d752dc` (feat)

_Note: All 18 new i18n keys (spanning both tasks' key lists) were added to the six locale files in Task 1's commit, since both tasks' `<files>` lists include the same locale files and adding them together in one editing pass avoided re-touching the same JSON blocks twice. Task 2's commit contains only `MySharesDialog.tsx`/`.test.tsx`._

## Files Created/Modified

- `apps/web/src/lib/api.ts` - Added `bulkShareResponseSchema`/`BulkShareRequest` imports and `api.vodShares.bulk(input)`.
- `apps/web/src/hooks/useVodShares.ts` - Added `useBulkVodShares()`.
- `apps/web/src/pages/VodManager/components/ShareRow.tsx` - Active-row Delete + honest confirm; `selectionMode`/`selected`/`onToggleSelected` props + checkbox.
- `apps/web/src/pages/VodManager/components/ShareRow.test.tsx` - Tests for active-row Delete flow and the prop-gated selection checkbox.
- `apps/web/src/pages/VodManager/MySharesDialog.tsx` - Selection mode (`Set<shareId>`), select-all, selection count, bulk Revoke/Delete + one dialog-level confirm.
- `apps/web/src/pages/VodManager/MySharesDialog.test.tsx` - Tests for selection mode, bulk Revoke, bulk Delete, and Cancel clearing selection.
- `apps/web/src/i18n/locales/{en,es,fr,de,pt,ja}.json` - 18 new `vodManager.shares.*` keys per locale (deleteActiveConfirmTitle/Description, deleteActiveShareAria, selectRowAria, selectModeEnter/Cancel, selectAll, selectionCount_one/_other, bulkRevoke, bulkDelete, bulkRevokeConfirmTitle, bulkRevokeConfirmDescription_one/_other, bulkDeleteConfirmTitle, bulkDeleteConfirmDescription_one/_other, bulkDoneToast_one/_other).

## Decisions Made

- Reused `useDeleteVodShare`'s existing mutation for the new active-row Delete confirm instead of introducing a second delete mutation — Plan 02 already made the endpoint succeed on active shares, so only the confirm copy and open-state needed to differ.
- Reused the single-row `revokeConfirmAction`/`deleteConfirmAction` copy for the bulk `AlertDialogAction` button text (instead of the toolbar trigger's short "Revoke"/"Delete") to avoid two visually-simultaneous buttons sharing identical accessible names.
- Selection is available on every row regardless of status (active or revoked) — the client does not gate eligibility; the server's bulk endpoint already reports `skipped` counts for no-op actions.

## Deviations from Plan

None - plan executed exactly as written. (Note above about combining both tasks' i18n keys into one commit is an implementation-sequencing detail, not a scope or behavior deviation — every acceptance criterion in both tasks passed independently.)

## Issues Encountered

- `@smash-tracker/shared` had no built `dist/` output in this fresh worktree, so the first test run failed to resolve `@smash-tracker/shared` imports. Ran `pnpm --filter @smash-tracker/shared build` once before testing (environment setup, not a plan deviation) — no source changes required.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- FB-03's web half is complete and independently verified: `ShareRow.test.tsx` (10 tests) and `MySharesDialog.test.tsx` (7 tests) pass, the full web suite (135 files / 1274 tests) stays green, `tsc --noEmit` is clean, and `pnpm --filter @smash-tracker/web lint` reports 0 errors (pre-existing warnings only, none in touched files).
- No blockers for downstream phases. This plan's `api.vodShares.bulk`/`useBulkVodShares` surface is now available for reuse by any future bulk-action UI on shares.

---

_Phase: 09-walkthrough-hardening_
_Completed: 2026-07-18_

## Self-Check: PASSED

All 12 modified source files verified present on disk; all 3 commits (`0f42a02`, `2d752dc`, `00f9fc6`) verified present in git history.
