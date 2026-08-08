import { useTranslation } from 'react-i18next';
import type { ClientHubRow } from '@smash-tracker/shared';
import { isResearchKind } from '@smash-tracker/shared';
import { Badge } from '@/components/ui/badge';

/**
 * Phase 29 (Research Tenancy, Isolation & Governance Gate, RTEN-01/RTEN-02,
 * review finding 29-07 HIGH): the Client Hub's per-row tri-state kind
 * indicator — mirrors `ClaimStatusBadge.tsx`'s convention exactly: takes the
 * hub row as its single prop, reads the row's `kind` straight off that row
 * (no extra request — `clientHubRowSchema.kind` is a required field, never
 * absent), and renders through the existing `Badge` primitive.
 *
 * Three-way render: the research resolution shows the research label; the
 * unresolved resolution shows a VISUALLY DISTINCT unresolved label (the
 * fail-closed signal — never a synonym for ordinary, never a synonym for
 * research); the ordinary resolution renders nothing, exactly like
 * `ClaimStatusBadge` renders nothing for a state that doesn't apply.
 *
 * `isResearchKind` (from `@smash-tracker/shared`) is the ONE predicate
 * permitted to compare a kind value against the `'research'` member — this
 * component never writes a literal `=== 'research'` comparison itself.
 */
export function ResearchBadge({ client }: { client: ClientHubRow }) {
  const { t } = useTranslation();

  if (isResearchKind(client.kind)) {
    return <Badge variant="secondary">{t('coaching.research.badge.research')}</Badge>;
  }

  if (client.kind === 'unresolved') {
    return <Badge variant="destructive">{t('coaching.research.badge.unresolved')}</Badge>;
  }

  return null;
}
