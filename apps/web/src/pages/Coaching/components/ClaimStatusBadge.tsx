import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ClientHubRow } from '@smash-tracker/shared';
import { Badge } from '@/components/ui/badge';

const MS_PER_HOUR = 60 * 60 * 1000;
/** Below this remaining window, show the "expires soon" copy instead of an hour count (never "0 hours"). */
const SOON_THRESHOLD_MS = MS_PER_HOUR;

/**
 * Phase 24 (Coach Issuance & Client Claim Experience, CTRL-03): per-client
 * claim-status badge for the Client Hub, read straight off
 * `clientHubRowSchema`'s `claimedAt`/`pendingInvitationExpiresAt` (24-02) —
 * no extra request.
 *
 * Derivation order is FIXED and must not be reordered: a non-null
 * `claimedAt` always renders Claimed, regardless of
 * `pendingInvitationExpiresAt`; otherwise a `pendingInvitationExpiresAt`
 * strictly in the future renders the code-active state; otherwise Managed.
 *
 * SECURITY/COPY CONSTRAINT (owner revision, `24-CONTEXT.md` Area 1.3): the
 * product never hands a claim code to the client directly — the coach
 * relays it out of band. This badge must NEVER assert or imply that a code
 * was sent to, delivered to, or received by anyone; it states only that a
 * code currently exists server-side and when it lapses.
 */
export function ClaimStatusBadge({ client }: { client: ClientHubRow }) {
  const { t } = useTranslation();
  // React Compiler forbids a bare `Date.now()` call in the render body (it's
  // impure) — a lazy `useState` initializer is the sanctioned one-time-read
  // escape hatch; a stale "now" across re-renders is harmless here since the
  // badge only needs to be right as of the render that used it.
  const [now] = useState(() => Date.now());

  if (client.claimedAt != null) {
    return <Badge variant="success">{t('coaching.hub.table.claimStatus.claimed')}</Badge>;
  }

  const expiresAt = client.pendingInvitationExpiresAt;
  const remainingMs = expiresAt != null ? expiresAt - now : null;

  if (remainingMs != null && remainingMs > 0) {
    if (remainingMs < SOON_THRESHOLD_MS) {
      return (
        <Badge variant="secondary">{t('coaching.hub.table.claimStatus.codeActiveSoon')}</Badge>
      );
    }
    const remainingHours = Math.floor(remainingMs / MS_PER_HOUR);
    return (
      <Badge variant="secondary">
        {t('coaching.hub.table.claimStatus.codeActive', { count: remainingHours })}
      </Badge>
    );
  }

  return <Badge variant="outline">{t('coaching.hub.table.claimStatus.managed')}</Badge>;
}
