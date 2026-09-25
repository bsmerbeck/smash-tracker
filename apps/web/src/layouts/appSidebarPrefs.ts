/**
 * Device-local preference for the app shell's persistent left rail
 * (`Sidebar`/`SidebarContent`, rendered from `MainLayout`) — cloned from the
 * collapse trio at the bottom of `apps/web/src/pages/VodManager/lib/vodPrefs.ts`:
 * a namespaced `smash-tracker.*` key, a pure `parseStored*` that tolerates
 * malformed content, and `readStored*`/`persist*` wrappers guarding
 * `typeof window === 'undefined'` and try/catch around every storage call.
 *
 * The storage key here is DELIBERATELY DISTINCT from
 * `VOD_SIDEBAR_COLLAPSED_STORAGE_KEY` in `vodPrefs.ts` — the app shell's rail
 * collapse and the VOD Manager's own in-page rail collapse are independent
 * preferences with independent scopes (navigation chrome vs. an in-page
 * filter panel), so collapsing one must never collapse or read the other.
 */

export const APP_SIDEBAR_COLLAPSED_STORAGE_KEY = 'smash-tracker.appSidebarCollapsed';

/**
 * Parses the persisted app-shell rail collapse preference: only the exact
 * stored `'true'` literal resolves to collapsed. Any other value (null,
 * empty, `'TRUE'`, `'1'`, malformed content) falls back to `false` — the
 * default EXPANDED rail — so a device that never touches the toggle, and a
 * device whose storage is broken or tampered with, both see the unchanged
 * layout.
 */
export function parseStoredAppSidebarCollapsed(raw: string | null): boolean {
  return raw === 'true';
}

/** Reads the app-shell rail collapse preference, defaulting to expanded on any failure. */
export function readStoredAppSidebarCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return parseStoredAppSidebarCollapsed(
      window.localStorage.getItem(APP_SIDEBAR_COLLAPSED_STORAGE_KEY),
    );
  } catch {
    return false;
  }
}

/** Persists the app-shell rail collapse preference, silently ignoring storage failures. */
export function persistAppSidebarCollapsed(collapsed: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(APP_SIDEBAR_COLLAPSED_STORAGE_KEY, String(collapsed));
  } catch {
    // Ignore storage failures — the collapse preference just won't persist this session.
  }
}
