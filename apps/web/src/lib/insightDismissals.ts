// Plan 39.1-12 (INS-02/INS-04, T-39.1-12-01..05): RED-phase stub. Every
// function below has the GREEN-phase signature but a deliberately wrong
// body, so `insightDismissals.test.ts` fails on real assertions rather than
// a module-load crash. Filled in for real during the GREEN commit.

export const INSIGHT_DISMISSALS_KEY_PREFIX = 'TODO-not-yet-implemented';
export const MAX_DISMISSED_INSIGHTS = 100;

export function insightDismissalsStorageKey(_uid: string, _clientId: string | null): string {
  return '';
}

export function parseStoredDismissals(_raw: string | null): string[] {
  return [];
}

export function readStoredDismissals(_uid: string | null, _clientId: string | null): string[] {
  return [];
}

export function writeStoredDismissals(
  _uid: string | null,
  _clientId: string | null,
  _ids: string[],
): void {
  // RED-phase no-op.
}

export function capDismissedIds(ids: string[]): string[] {
  return ids;
}
