// Plan 39.1-12 (INS-02/INS-04, T-39.1-12-01..05): RED-phase stub. Filled in
// for real during the GREEN commit.
export interface UseInsightDismissalsResult {
  dismissedIds: string[];
  dismiss: (id: string) => void;
  restoreAll: () => void;
  isLoading: boolean;
}

export function useInsightDismissals(): UseInsightDismissalsResult {
  return {
    dismissedIds: [],
    dismiss: () => {},
    restoreAll: () => {},
    isLoading: false,
  };
}
