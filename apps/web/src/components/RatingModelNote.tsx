import { useContext, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { RATING_MODEL_VERSION } from '@/lib/glicko';
import { AuthContext } from '@/context/AuthContext';
import { Button } from '@/components/ui/button';
import { dismissRatingModelNote, isRatingModelNoteDismissed } from '@/lib/ratingModelNote';

/**
 * Phase 36 (TRND-01, D-02): a full-width, dismissible disclosure that the
 * session rating model changed and the full history was recomputed under it
 * — displayed rating numbers must never change silently. Mounted once per
 * page, immediately above the first rating-bearing region, on every page
 * that hosts a session-Glicko consumer (Dashboard, Trends, Groups, GSP —
 * see this plan's SUMMARY for the source enumeration).
 *
 * Reads the uid via `useContext(AuthContext)` directly (not `useAuth()`) so
 * it degrades to not-dismissed instead of throwing when rendered outside an
 * `AuthProvider` — the same precedent `useMinStageMatches` uses. It takes no
 * subject/client prop: the historical recompute is one global decision
 * (D-02), not a per-coach-client one, so dismissing the note on one page
 * dismisses it everywhere for this uid, including under a coach
 * client-subject route (T-36-02-02-style non-regression).
 */
export function RatingModelNote() {
  const { t } = useTranslation();
  const auth = useContext(AuthContext);
  const uid = auth?.user?.uid ?? null;
  // A pure, cheap localStorage read on every render (same discipline as
  // `readStoredSelection`) rather than a lazily-initialized `useState` —
  // the uid resolves asynchronously (Firebase's `onAuthStateChanged` fires
  // after mount), so a lazy initializer would freeze a stale null-uid read
  // for the component's lifetime. `dismissedThisSession` covers the
  // same-render dismiss click, which a fresh localStorage read alone
  // wouldn't reflect until the next unrelated re-render.
  const [dismissedThisSession, setDismissedThisSession] = useState(false);
  const dismissed = dismissedThisSession || isRatingModelNoteDismissed(uid, RATING_MODEL_VERSION);

  if (dismissed) {
    return null;
  }

  return (
    <div className="flex w-full items-start justify-between gap-2 rounded-lg border p-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium text-muted-foreground">
          {t('shared.ratingModelNote.title')}
        </h3>
        <p className="text-sm text-muted-foreground">{t('shared.ratingModelNote.body')}</p>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={t('shared.ratingModelNote.dismiss')}
        className="shrink-0 text-muted-foreground hover:text-foreground"
        onClick={() => {
          dismissRatingModelNote(uid, RATING_MODEL_VERSION);
          setDismissedThisSession(true);
        }}
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}
