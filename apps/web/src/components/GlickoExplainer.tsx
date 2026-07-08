import { Trans, useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';

/**
 * Shared plain-English explainer for the Glicko-2 rating system, rendered
 * identically from both the Dashboard Rating card and the Trends Rating
 * Curve header (V9-C) so the two call sites never drift out of sync. An
 * `Info` icon trigger opens a Popover (chosen over Tooltip per house
 * precedent — this much copy reads poorly in a hover-only tooltip).
 */
export function GlickoExplainer() {
  const { t } = useTranslation();

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t('shared.glicko.whatIs')}
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <Info className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 text-sm">
        <PopoverHeader>
          <PopoverTitle>{t('shared.glicko.whatIs')}</PopoverTitle>
          <p>
            <Trans i18nKey="shared.glicko.p1" components={{ strong: <strong />, em: <em /> }} />
          </p>
          <p>
            <Trans i18nKey="shared.glicko.p2" components={{ strong: <strong />, em: <em /> }} />
          </p>
          <p>
            <Trans i18nKey="shared.glicko.p3" components={{ strong: <strong />, em: <em /> }} />
          </p>
        </PopoverHeader>
      </PopoverContent>
    </Popover>
  );
}
