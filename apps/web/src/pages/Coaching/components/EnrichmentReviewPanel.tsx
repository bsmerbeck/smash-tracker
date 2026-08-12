import { useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import type { ResearchEnrichmentObservationRecord } from '@smash-tracker/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useConfirmEnrichmentCandidate, useEnrichmentReview } from '@/hooks/useEnrichmentReview';

/**
 * One review-queue item: an ambiguous/conflicting/unmatched Liquipedia
 * observation, its source page link, its bracket key, its players, its raw
 * scores, its derived round label (explanation only — plainly stated as
 * such, so an admin never reads it as a matching signal, RESEARCH section
 * 2.7's own warning that round labels are a WEAK signal derived from
 * template+section+index, not a source-declared fact), and its competing
 * candidate target sets alongside the evidence recorded for the
 * observation. Confirming a candidate calls the mutation with the selected
 * `targetSetId`; the caller (the panel below) owns removing the item from
 * the rendered queue on success.
 */
function EnrichmentReviewItem({
  observation,
  confirming,
  onConfirm,
  t,
}: {
  observation: ResearchEnrichmentObservationRecord;
  confirming: boolean;
  onConfirm: (targetSetId: string) => void;
  t: TFunction;
}) {
  const [selectedCandidate, setSelectedCandidate] = useState<string | null>(null);
  const candidates = observation.candidateTargetSetIds ?? [];
  const testidPrefix = `enrichment-review-item-${observation.observationId}`;

  return (
    <div data-testid={testidPrefix} className="rounded-md border p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span data-testid={`${testidPrefix}-status`} className="font-medium">
          {t(`enrichment.review.status.${observation.matchingStatus}`)}
        </span>
        {observation.sourcePageUrl != null && (
          <a
            href={observation.sourcePageUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs underline"
          >
            {t('enrichment.review.sourceLink')}
          </a>
        )}
      </div>

      {observation.bracketKey != null && (
        <p className="text-xs text-muted-foreground">{observation.bracketKey}</p>
      )}

      {observation.players != null && (
        <p className="text-xs">
          {observation.players[0].rawTag} vs. {observation.players[1].rawTag}
        </p>
      )}

      {observation.rawScores != null && (
        <p className="text-xs">
          {observation.rawScores[0]} – {observation.rawScores[1]}
        </p>
      )}

      {observation.derivedRoundLabel != null && (
        <p className="text-xs text-muted-foreground">
          {t('enrichment.review.derivedRoundExplanationOnly', {
            label: observation.derivedRoundLabel,
          })}
        </p>
      )}

      {candidates.length === 0 ? (
        <p
          data-testid={`${testidPrefix}-no-candidates`}
          className="mt-2 text-xs text-muted-foreground"
        >
          {t('enrichment.review.noCandidates')}
        </p>
      ) : (
        <div className="mt-2 flex flex-col gap-1">
          {candidates.map((candidateId) => (
            <label key={candidateId} className="flex items-center gap-2 text-xs">
              <input
                type="radio"
                name={`enrichment-review-candidate-${observation.observationId}`}
                value={candidateId}
                checked={selectedCandidate === candidateId}
                onChange={() => setSelectedCandidate(candidateId)}
              />
              <span>{candidateId}</span>
            </label>
          ))}
          {observation.resolutionReasons != null && observation.resolutionReasons.length > 0 && (
            <ul
              data-testid={`${testidPrefix}-evidence`}
              className="ml-5 list-disc text-xs text-muted-foreground"
            >
              {observation.resolutionReasons.map((reason, index) => (
                <li key={index}>{reason}</li>
              ))}
            </ul>
          )}
          <Button
            type="button"
            size="sm"
            className="mt-1 w-fit"
            disabled={selectedCandidate == null || confirming}
            onClick={() => selectedCandidate != null && onConfirm(selectedCandidate)}
          >
            {t('enrichment.review.confirmButton')}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * Phase 30.2 Plan 11 (ENR-06): the admin review-and-act queue for
 * ambiguous/conflicting/unmatched Liquipedia observations. No shipped UI
 * analog exists (PATTERNS.md "No Analog Found") — modeled on the coverage
 * panel's Card layout and pending/error/empty degrade conventions, and on
 * the identity-confirm API's own contract (a candidate is never promoted by
 * any writer other than an explicit admin confirmation).
 *
 * Takes no props and consumes `useEnrichmentReview()`/
 * `useConfirmEnrichmentCandidate()` itself, mirroring `DataCoveragePanel`'s
 * self-contained shape. Renders nothing on an ordinary workspace, while the
 * query is pending, or when the server answers the research family's
 * uniform 404 (`isForbidden`) — a 404 means "not for you", never a failure.
 *
 * A confirmed item is removed from the rendered queue via LOCAL state
 * (`confirmedObservationIds`) rather than relying solely on the
 * invalidate-and-refetch the mutation also triggers — the store's
 * attachment-absence selection means a confirmed observation can never
 * reappear once attached, so tracking it locally is a safe, deterministic
 * complement that does not depend on a second network round-trip landing
 * before the next assertion.
 */
export function EnrichmentReviewPanel() {
  const { t } = useTranslation();
  const { isResearch, isPending, isError, isForbidden, data } = useEnrichmentReview();
  const confirmCandidate = useConfirmEnrichmentCandidate();
  const [confirmedObservationIds, setConfirmedObservationIds] = useState<Set<string>>(new Set());

  if (!isResearch || isPending || isForbidden) {
    return null;
  }

  const title = t('enrichment.review.title');

  if (isError) {
    return (
      <Card role="region" aria-label={title} data-testid="enrichment-review-panel" className="mb-4">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <CardContent>
          <p data-testid="enrichment-review-load-error" className="text-sm text-destructive">
            {t('enrichment.review.loadError')}
          </p>
        </CardContent>
      </Card>
    );
  }

  const observations = (data?.observations ?? []).filter(
    (observation) => !confirmedObservationIds.has(observation.observationId),
  );

  return (
    <Card role="region" aria-label={title} data-testid="enrichment-review-panel" className="mb-4">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {observations.length === 0 ? (
          <p data-testid="enrichment-review-empty" className="text-sm text-muted-foreground">
            {t('enrichment.review.empty')}
          </p>
        ) : (
          observations.map((observation) => (
            <EnrichmentReviewItem
              key={observation.observationId}
              observation={observation}
              confirming={confirmCandidate.isPending}
              t={t}
              onConfirm={(targetSetId) => {
                confirmCandidate.mutate(
                  { observationId: observation.observationId, targetSetId },
                  {
                    onSuccess: () => {
                      setConfirmedObservationIds((prev) =>
                        new Set(prev).add(observation.observationId),
                      );
                    },
                  },
                );
              }}
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}
