/**
 * Phase 38-04: the Matchups results-list scroll target. Previously exported
 * from `components/MatchupTable.tsx`, which retired entirely once its
 * narrowing/notice-bar/delete responsibilities moved to the shared
 * `FilteredMatchList` terminus (D-07) — this constant is the one thing that
 * survived the retirement, so it lives in its own module rather than being
 * re-homed into `MatchupsPage.tsx` (which would force `CounterpickAdvisor`
 * and `MatchupChart` to import from the page that imports them, a
 * circular dependency).
 */
export const MATCHUP_TABLE_ANCHOR_ID = 'matchup-table';

/**
 * Plan 39.1-44 (PD-44-3): the matrix's in-page anchor — the pairing hero's
 * "Other pairings" door targets it. Its own constant (not exported from the
 * page or the matrix) so the hero and the page share it without a cycle.
 */
export const MATCHUP_MATRIX_ANCHOR_ID = 'matchup-matrix';
