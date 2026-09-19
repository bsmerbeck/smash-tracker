import { useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { Match, SampleMeta } from '@smash-tracker/shared';
import {
  EVIDENCE_POLICY_VERSION,
  MASTERY_CAPTION_MIN_GAMES,
  RECENCY_TREATMENT,
  confidenceTierFor,
} from '@smash-tracker/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { stageAbbreviation } from '@/components/StageOption';
import { stagesById } from '@/data/stages';
import { buildStageEvidence, type RankedStage } from '@/lib/stats';
import { SampleCue } from '@/components/EvidenceCues';
import { buildStageMasteryTiles } from '../lib/stageMastery';
import type { MasteryTintBucket, StageMasteryTile } from '../lib/stageMastery';

/** Tile tint per Wilson bucket, mirroring the Matchups matrix's red -> grey -> emerald convention (implemented locally here, not imported, per the Fighter Analysis spec). */
const TINT_CLASSES: Record<MasteryTintBucket, string> = {
  weak: 'border-destructive/50 bg-destructive/10',
  even: 'border-border bg-muted/40',
  strong: 'border-emerald-500/50 bg-emerald-500/10',
};

/** A per-stage `SampleMeta` for the caption's `SampleCue`, mirroring `MatchupStageGuide.tsx`'s `stageCell` helper — `RankedStage` carries no `SampleMeta` of its own. */
function sampleForStage(record: RankedStage, refreshedAt: number): SampleMeta {
  return {
    rawSampleSize: record.total,
    eligibleDenominator: record.total,
    knownFieldCoverage: 1,
    dateRange: null,
    refreshedAt,
    evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
    recencyTreatment: RECENCY_TREATMENT,
    confidenceTier: confidenceTierFor(record.total),
  };
}

/**
 * Every stage with at least one recorded game for the selected fighter, as an
 * art tile grid ordered by Wilson evidence (best first), tinted by that
 * Wilson bucket. A "Best pick / Ban-worthy" caption row up top calls out the
 * standout stages (folds in the retired BestWorstMap card per
 * docs/analytics-vision.md V4 Phase E).
 *
 * Phase 38-06 (ADV-03/D-13): the caption is built from `buildStageEvidence`
 * — the SAME gated engine call `MatchupStageGuide.tsx` already reads — so
 * both surfaces share one claim shape, one abstention message and one
 * sample cue. Below the abstention floor, the caption row is REPLACED by
 * the shared games-needed sentence rather than rendering nothing (rendering
 * nothing would be indistinguishable from "no standout stage").
 *
 * `title` defaults to "Stage Mastery" (its original framing here); pass a
 * more specific title to reuse this same tile grid for a different subject,
 * e.g. the Scout page's "Full analysis" section rendering it once for a
 * scouted player's whole sample and again for just their top character.
 *
 * **This component MUST stay ROUTER-FREE.** It is rendered TWICE by
 * `Scout/components/FullAnalysisSection.tsx`, over a SCOUTED PLAYER's
 * matches, whose test file renders that host BARE — no `<MemoryRouter>`,
 * no `<QueryClientProvider>` — six times. React hooks cannot be called
 * conditionally, so a `useSubjectPath()` (or any router/query hook) call
 * here would throw at that host regardless of whether it opted into
 * drill-down. The opt-in is therefore a HOST-SUPPLIED destination builder,
 * never an internal hook: `stageHref?: (stageId: number) => string`. When a
 * host supplies it, a tile and a caption stage name are real `<Link>`s to
 * `stageHref(stageId)`; when no host supplies it (the Scout host, whose
 * data belongs to a third party — a stage link would silently resolve into
 * the VIEWER's own history), they stay plain text with no link semantics.
 * Importing `Link` at module scope is fine (an import never throws); it
 * only RENDERS in the opted-in branch, which the Scout host never takes.
 */
export function StageMastery({
  fighterMatches,
  title,
  stageHref,
}: {
  fighterMatches: Match[];
  title?: string;
  /** Host-supplied destination builder — see the component doc comment above for why this is a prop, not an internal router hook. */
  stageHref?: (stageId: number) => string;
}) {
  const { t } = useTranslation();
  // React Compiler forbids a bare `Date.now()` call in the render body — a
  // lazy `useState` initializer is the sanctioned one-time-read escape
  // hatch, matching `MatchupStageGuide.tsx`'s convention.
  const [refreshedAt] = useState(() => Date.now());
  const tiles = buildStageMasteryTiles(fighterMatches);
  const { claim } = buildStageEvidence({
    matches: fighterMatches,
    refreshedAt,
    minMatches: MASTERY_CAPTION_MIN_GAMES,
  });
  const bestPick = claim.kind === 'evidenced' ? (claim.value[0] ?? null) : null;
  const banWorthy =
    claim.kind === 'evidenced' && claim.value.length > 1
      ? (claim.value[claim.value.length - 1] ?? null)
      : null;

  function stageNameNode(stageId: number) {
    const name = stagesById.get(stageId)?.name ?? t('common.unknown');
    if (!stageHref) {
      return <>{name}</>;
    }
    return (
      <Link to={stageHref(stageId)} className="underline-offset-2 hover:underline">
        {name}
      </Link>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title ?? t('fighterAnalysis.stageMastery.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {claim.kind === 'abstained' ? (
          <p className="text-sm text-muted-foreground">
            {t('shared.evidence.abstained', { count: claim.gamesNeeded })}
          </p>
        ) : (
          (bestPick || banWorthy) && (
            <div className="flex flex-wrap gap-4 text-sm">
              {bestPick && (
                <p className="flex flex-wrap items-center gap-1">
                  <span className="font-medium text-emerald-500">
                    {t('fighterAnalysis.stageMastery.bestPick')}
                  </span>{' '}
                  {stageNameNode(bestPick.stageId)}{' '}
                  {t('common.rateOverSample', { rate: bestPick.winRate, total: bestPick.total })}{' '}
                  <SampleCue sample={sampleForStage(bestPick, refreshedAt)} />
                </p>
              )}
              {banWorthy && (
                <p className="flex flex-wrap items-center gap-1">
                  <span className="font-medium text-destructive">
                    {t('fighterAnalysis.stageMastery.banWorthy')}
                  </span>{' '}
                  {stageNameNode(banWorthy.stageId)}{' '}
                  {t('common.rateOverSample', { rate: banWorthy.winRate, total: banWorthy.total })}{' '}
                  <SampleCue sample={sampleForStage(banWorthy, refreshedAt)} />
                </p>
              )}
            </div>
          )
        )}

        {tiles.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('fighterAnalysis.stageMastery.empty')}</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            {tiles.map((tile) => (
              <StageTile key={tile.stageId} tile={tile} stageHref={stageHref} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StageTile({
  tile,
  stageHref,
}: {
  tile: StageMasteryTile;
  stageHref?: (stageId: number) => string;
}) {
  const { t } = useTranslation();
  const stage = stagesById.get(tile.stageId);
  const name = stage?.name ?? t('common.unknown');

  const body = (
    <div className={`flex flex-col overflow-hidden rounded-lg border ${TINT_CLASSES[tile.tint]}`}>
      {stage?.url ? (
        <img src={stage.url} alt="" className="h-20 w-full object-cover" loading="lazy" />
      ) : (
        <div
          className="flex h-20 w-full items-center justify-center bg-muted text-lg font-semibold text-muted-foreground"
          aria-hidden="true"
        >
          {stageAbbreviation(name)}
        </div>
      )}
      <div className="flex flex-col gap-0.5 p-2">
        <span className="truncate text-sm font-medium">{name}</span>
        <span className="text-xs text-muted-foreground">
          {tile.wins}-{tile.losses} &middot; {tile.winRate}% ({tile.total})
        </span>
      </div>
    </div>
  );

  if (!stageHref) {
    return body;
  }

  return (
    <Link
      to={stageHref(tile.stageId)}
      className="rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      {body}
    </Link>
  );
}
