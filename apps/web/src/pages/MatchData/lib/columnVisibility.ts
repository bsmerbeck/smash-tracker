import type { VisibilityState } from '@tanstack/react-table';

export const MATCH_TABLE_COLUMNS_STORAGE_KEY = 'smash-tracker.matchTableColumns';

/** Parses a persisted `VisibilityState`, tolerating missing/malformed localStorage content — same defensive shape as `AnalyticsFilterContext`'s persistence helpers. */
export function parseStoredColumnVisibility(raw: string | null): VisibilityState {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const result: VisibilityState = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'boolean') {
        result[key] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}

export function readStoredColumnVisibility(): VisibilityState {
  if (typeof window === 'undefined') return {};
  try {
    return parseStoredColumnVisibility(
      window.localStorage.getItem(MATCH_TABLE_COLUMNS_STORAGE_KEY),
    );
  } catch {
    return {};
  }
}

export function persistColumnVisibility(state: VisibilityState): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(MATCH_TABLE_COLUMNS_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage failures — visibility just won't persist this session.
  }
}
