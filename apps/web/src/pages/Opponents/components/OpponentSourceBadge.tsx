import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { OpponentSource } from '@/hooks/useFilteredMatches';

/**
 * Tasteful, non-shouty source indicator for an opponent identity: a
 * verified check badge (start.gg or parry.gg) when every recorded match
 * against them came from that one tournament site, an outline "manual"
 * badge when none were, or the "mixed" combination (labeled via aria) when
 * the identity spans more than one source — manual plus a verified site, OR
 * (V8-A) both start.gg and parry.gg with no manual matches at all; either
 * way it's "more than one source", so both render the same multi-badge
 * state rather than adding a fourth dedicated combination.
 */
export function OpponentSourceBadge({ source }: { source: OpponentSource }) {
  const { t } = useTranslation();
  if (source === 'mixed') {
    return (
      <span className="inline-flex items-center gap-1" aria-label={t('opponents.source.mixedAria')}>
        <Badge variant="success" className="gap-0.5">
          <Check className="size-3" />
          {t('opponents.source.verified')}
        </Badge>
        <Badge variant="outline">{t('opponents.source.manual')}</Badge>
      </span>
    );
  }

  if (source === 'startgg') {
    return (
      <Badge variant="success" className="gap-0.5" aria-label={t('opponents.source.startggAria')}>
        <Check className="size-3" />
        start.gg
      </Badge>
    );
  }

  if (source === 'parrygg') {
    return (
      <Badge variant="success" className="gap-0.5" aria-label={t('opponents.source.parryggAria')}>
        <Check className="size-3" />
        parry.gg
      </Badge>
    );
  }

  return (
    <Badge variant="outline" aria-label={t('opponents.source.manualAria')}>
      {t('opponents.source.manual')}
    </Badge>
  );
}
