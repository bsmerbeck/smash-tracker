import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useVodShares } from '@/hooks/useVodShares';
import { ShareRow } from './components/ShareRow';

/**
 * "My shares" manage list (SHARE-05) — opened from the VOD Manager toolbar
 * button beside the page `<h1>`. Mirrors `VodNotesDialog`'s scroll/overflow
 * shape (`max-h-[90vh] overflow-y-auto`) for a query-driven list of
 * `ShareRow`s, one per active or revoked share.
 */
export function MySharesDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const sharesQuery = useVodShares();
  const shares = sharesQuery.data ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('vodManager.shares.mySharesTitle')}</DialogTitle>
          <DialogDescription>{t('vodManager.shares.mySharesDescription')}</DialogDescription>
        </DialogHeader>

        {sharesQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">{t('vodManager.shares.loadingShares')}</p>
        ) : shares.length === 0 ? (
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">{t('vodManager.shares.emptyTitle')}</p>
            <p className="text-sm text-muted-foreground">{t('vodManager.shares.emptyBody')}</p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2" aria-label={t('vodManager.shares.mySharesTitle')}>
            {shares.map((share) => (
              <li key={share.shareId}>
                <ShareRow share={share} />
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
