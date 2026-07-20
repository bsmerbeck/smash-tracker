import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { toast } from 'sonner';
import { MoreHorizontal, Plus } from 'lucide-react';
import type { ReviewDeliveryListItem, ReviewListItem } from '@/lib/api';
import {
  useArchiveCoachingReview,
  useCoachingReviews,
  useCreateCoachingReview,
  useCreateReviewDelivery,
  useReviewDeliveries,
  useRevokeReviewDelivery,
} from '@/hooks/useCoachingReviews';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/** D-05: `Draft / Published vN / Archived` — the review-side state machine. Never mixed with the delivery chip below. */
function ReviewStatusBadge({ item }: { item: ReviewListItem }) {
  const { t } = useTranslation();
  if (item.status === 'draft') {
    return <Badge variant="outline">{t('coaching.reviews.list.status.draft')}</Badge>;
  }
  if (item.status === 'archived') {
    return <Badge variant="outline">{t('coaching.reviews.list.status.archived')}</Badge>;
  }
  return (
    <Badge variant="secondary">
      {t('coaching.reviews.list.status.published', { version: item.latestVersion ?? 0 })}
    </Badge>
  );
}

/** D-05/D-14: the delivery-side state machine — `—` for a draft (no delivery lifecycle exists yet), else one of the 6 delivery states. Never mixed with the review-status chip above. */
function DeliveryStatusBadge({
  deliveryState,
}: {
  deliveryState: ReviewListItem['deliveryState'];
}) {
  const { t } = useTranslation();
  if (deliveryState == null) {
    return (
      <Badge variant="outline" aria-label={t('coaching.reviews.list.delivery.noneAria')}>
        {t('coaching.reviews.list.delivery.dash')}
      </Badge>
    );
  }
  const labelKey: Record<NonNullable<ReviewListItem['deliveryState']>, string> = {
    'not-delivered': 'coaching.reviews.list.delivery.notDelivered',
    delivered: 'coaching.reviews.list.delivery.delivered',
    viewed: 'coaching.reviews.list.delivery.viewed',
    acknowledged: 'coaching.reviews.list.delivery.acknowledged',
    expired: 'coaching.reviews.list.delivery.expired',
    revoked: 'coaching.reviews.list.delivery.revoked',
  };
  const variant =
    deliveryState === 'acknowledged'
      ? 'success'
      : deliveryState === 'revoked' || deliveryState === 'expired'
        ? 'destructive'
        : 'secondary';
  return <Badge variant={variant}>{t(labelKey[deliveryState])}</Badge>;
}

function reviewRowLabel(t: TFunction, item: ReviewListItem): string {
  return t('coaching.reviews.list.rowLabel', {
    date: new Date(item.createdAt).toLocaleDateString(),
  });
}

interface ReviewDeliveryMenuProps {
  clientId: string;
  review: ReviewListItem;
}

/**
 * D-05: the review row's SEPARATE delivery/overflow menu — never merged
 * with the `Open` button. Lazily fetches this review's delivery history
 * only once the menu is actually opened (a closed menu never fetches).
 */
function ReviewDeliveryMenu({ clientId, review }: ReviewDeliveryMenuProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const deliveries = useReviewDeliveries(clientId, review.reviewId, { enabled: open });
  const createDelivery = useCreateReviewDelivery(clientId, review.reviewId);
  const revokeDelivery = useRevokeReviewDelivery(clientId, review.reviewId);
  const archiveReview = useArchiveCoachingReview(clientId);

  const activeDelivery: ReviewDeliveryListItem | null =
    deliveries.data?.find((delivery) => delivery.revokedAt == null) ?? null;
  const canDeliver = review.status === 'published' && review.latestVersion != null;

  async function copyToClipboard(url: string) {
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Clipboard permission denied — the coach still sees the success toast
      // for the underlying create/reveal action; copying is a convenience.
    }
  }

  async function handleDeliver() {
    if (!review.latestVersion) return;
    try {
      const result = await createDelivery.mutateAsync({ version: review.latestVersion });
      await copyToClipboard(result.url);
      toast.success(t('coaching.reviews.list.delivery.createdToast'));
    } catch {
      toast.error(t('coaching.reviews.list.delivery.createError'));
    }
  }

  async function handleCopyLink() {
    if (!activeDelivery) return;
    await copyToClipboard(activeDelivery.url);
    toast.success(t('coaching.reviews.list.delivery.copiedToast'));
  }

  async function handleRevoke() {
    if (!activeDelivery) return;
    try {
      await revokeDelivery.mutateAsync(activeDelivery.deliveryId);
      toast.success(t('coaching.reviews.list.delivery.revokedToast'));
    } catch {
      toast.error(t('coaching.reviews.list.delivery.revokeError'));
    }
  }

  async function handleArchive() {
    try {
      await archiveReview.mutateAsync(review.reviewId);
      toast.success(t('coaching.reviews.list.archiveToast'));
    } catch {
      toast.error(t('coaching.reviews.list.archiveError'));
    }
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label={t('coaching.reviews.list.deliveryMenuAria')}
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem disabled={!canDeliver} onSelect={handleDeliver}>
          {t('coaching.reviews.list.actions.deliver')}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!activeDelivery} onSelect={handleCopyLink}>
          {t('coaching.reviews.list.actions.copyLink')}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!activeDelivery} onSelect={handleRevoke}>
          {t('coaching.reviews.list.actions.revokeLink')}
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onSelect={handleArchive}>
          {t('coaching.reviews.list.actions.archive')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * D-05: the Reviews list — one row per review, an `Open` button (→ the
 * composer) plus a SEPARATE delivery overflow menu (`ReviewDeliveryMenu`
 * above), and two non-mixing status chips. `+ New review` starts a fresh
 * draft directly (VOD Manager's own `Start review / Continue review`
 * action, D-01, is the source-preloaded entry point — this button is the
 * plain "no VOD in mind yet" path).
 */
export function ReviewsListPage() {
  const { t } = useTranslation();
  const { clientId = '' } = useParams<{ clientId: string }>();
  const navigate = useNavigate();
  const reviewsQuery = useCoachingReviews(clientId);
  const createReview = useCreateCoachingReview(clientId);

  async function handleCreateReview() {
    try {
      const created = await createReview.mutateAsync();
      navigate(`/coach/${clientId}/reviews/${created.reviewId}`);
    } catch {
      toast.error(t('coaching.reviews.list.createError'));
    }
  }

  const reviews = reviewsQuery.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t('coaching.reviews.list.title')}
          </h1>
          <p className="text-sm text-muted-foreground">{t('coaching.reviews.list.subtitle')}</p>
        </div>
        <Button type="button" onClick={handleCreateReview} disabled={createReview.isPending}>
          <Plus className="size-4" />
          {t('coaching.reviews.list.newReview')}
        </Button>
      </div>

      {reviewsQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">{t('chrome.loading')}</p>
      ) : reviews.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('coaching.reviews.list.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-2" aria-label={t('coaching.reviews.list.listAria')}>
          {reviews.map((review) => (
            <li
              key={review.reviewId}
              className="flex flex-col gap-2 rounded-md border bg-card px-4 py-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3"
            >
              <div className="min-w-0 sm:flex-1">
                <p className="truncate text-sm font-medium">{reviewRowLabel(t, review)}</p>
                <p className="text-xs text-muted-foreground">
                  {t('coaching.reviews.list.rowEdited', {
                    date: new Date(review.lastAutosavedAt).toLocaleDateString(),
                  })}
                </p>
              </div>
              <div className="flex items-center gap-2 sm:contents">
                <ReviewStatusBadge item={review} />
                <DeliveryStatusBadge deliveryState={review.deliveryState} />
              </div>
              <div className="flex items-center gap-2 sm:contents">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => navigate(`/coach/${clientId}/reviews/${review.reviewId}`)}
                >
                  {t('coaching.reviews.list.open')}
                </Button>
                <div className="ml-auto sm:ml-0">
                  <ReviewDeliveryMenu clientId={clientId} review={review} />
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
