import { Check } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { OpponentSource } from '@/hooks/useFilteredMatches';

/**
 * Tasteful, non-shouty source indicator for an opponent identity: a
 * start.gg-verified check badge when every recorded match against them was
 * imported, an outline "manual" badge when none were, or both badges
 * together (labeled via aria) when the identity is a merge of manual +
 * imported matches.
 */
export function OpponentSourceBadge({ source }: { source: OpponentSource }) {
  if (source === 'mixed') {
    return (
      <span className="inline-flex items-center gap-1" aria-label="mixed sources">
        <Badge variant="success" className="gap-0.5">
          <Check className="size-3" />
          start.gg
        </Badge>
        <Badge variant="outline">manual</Badge>
      </span>
    );
  }

  if (source === 'startgg') {
    return (
      <Badge variant="success" className="gap-0.5" aria-label="start.gg-verified">
        <Check className="size-3" />
        start.gg
      </Badge>
    );
  }

  return (
    <Badge variant="outline" aria-label="manually entered">
      manual
    </Badge>
  );
}
