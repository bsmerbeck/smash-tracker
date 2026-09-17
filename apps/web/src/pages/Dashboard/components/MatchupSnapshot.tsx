import { useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { Match, SampleMeta } from '@smash-tracker/shared';
import {
  ABSTENTION_FLOOR_GAMES,
  EVIDENCE_POLICY_VERSION,
  RECENCY_TREATMENT,
  confidenceTierFor,
} from '@smash-tracker/shared';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { getFighterById } from '@/data/sprites';
import { localizedFighterName } from '@/lib/fighterNames';
import { filterByFighter, rankMatchupsByEvidence, type RankedMatchup } from '@/lib/stats';
import { SampleCue } from '@/components/EvidenceCues';
import { useSubjectPath } from '@/hooks/useSubjectPath';
import { useDashboardContext } from '../DashboardContext';

const SNAPSHOT_COUNT = 3;
const TOUGHEST_MIN_ROWS = 2;

export interface MatchupSnapshotData {
  strongest: RankedMatchup[];
  /** Empty when fewer than `TOUGHEST_MIN_ROWS` matchups meet the abstention floor — not enough evidence to call out a "toughest" matchup yet. */
  toughest: RankedMatchup[];
  /** True when there's ranked data at all, but not enough qualifying rows to show a toughest-matchups list. */
  needsMoreData: boolean;
}

/**
 * Wilson-ranked strongest/toughest matchup snapshot for the given
 * (already fighter-filtered) matches. Exported as a pure builder so the
 * ranking/threshold logic can be unit-tested without rendering.
 *
 * Phase 36 (D-24): `rankMatchupsByEvidence`'s default floor is already
 * `ABSTENTION_FLOOR_GAMES`; this now passes it explicitly (same value,
 * sourced not spelled) rather than relying on the engine's own default.
 */
export function buildMatchupSnapshot(fighterMatches: Match[]): MatchupSnapshotData {
  const ranked = rankMatchupsByEvidence(fighterMatches, ABSTENTION_FLOOR_GAMES);
  const strongest = ranked.slice(0, SNAPSHOT_COUNT);

  const qualifying = ranked.filter((row) => row.totalMatches >= ABSTENTION_FLOOR_GAMES);
  const toughest =
    qualifying.length >= TOUGHEST_MIN_ROWS ? qualifying.slice(-SNAPSHOT_COUNT).reverse() : [];

  return {
    strongest,
    toughest,
    needsMoreData: ranked.length > 0 && qualifying.length < TOUGHEST_MIN_ROWS,
  };
}

/**
 * Fighter-scoped matchup snapshot: strongest/toughest matchups ranked by
 * Wilson lower bound, with a link into the Matchup Lab (docs/analytics-vision.md
 * Phase C). Replaces the legacy-ratio-sorted `BestWorstMatchup`.
 *
 * Phase 36 (EVID-06, EVID-10): the "not enough data" toughest-matchups hint
 * now reads the shared abstained sentence, each rendered matchup row carries
 * the shared sample/confidence cue, and an evidence-type caption marks this
 * card as an inference (D-13, no new visual language).
 */
export function MatchupSnapshot({ matches }: { matches: Match[] }) {
  const { t } = useTranslation();
  const { fighter } = useDashboardContext();
  const subjectPath = useSubjectPath();
  // React Compiler forbids a bare `Date.now()` call in the render body (it's
  // impure) — a lazy `useState` initializer is the sanctioned one-time-read
  // escape hatch, matching `CounterpickAdvisor.tsx`'s convention.
  const [refreshedAt] = useState(() => Date.now());

  if (!fighter || matches.length === 0) {
    return (
      <Card>
        <CardContent className="pt-6">
          <h2 className="text-lg font-medium">{t('dashboard.snapshot.noMatches')}</h2>
        </CardContent>
      </Card>
    );
  }

  const fighterMatches = filterByFighter(matches, fighter.id);
  const { strongest, toughest, needsMoreData } = buildMatchupSnapshot(fighterMatches);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle>{t('dashboard.snapshot.title')}</CardTitle>
          <CardDescription>{t('shared.evidence.type.inference')}</CardDescription>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to={subjectPath('/matchups')}>{t('dashboard.snapshot.openLab')}</Link>
        </Button>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <MatchupList
          title={t('dashboard.snapshot.strongest')}
          entries={strongest}
          emptyHint={t('dashboard.snapshot.notEnough')}
          refreshedAt={refreshedAt}
        />
        <MatchupList
          title={t('dashboard.snapshot.toughest')}
          entries={toughest}
          emptyHint={
            needsMoreData
              ? // Deterministic: needsMoreData is only ever true when exactly
                // one matchup clears the floor (see buildMatchupSnapshot) —
                // one more qualifying matchup is always what's needed.
                t('shared.evidence.abstained', { count: TOUGHEST_MIN_ROWS - 1 })
              : t('dashboard.snapshot.notEnough')
          }
          refreshedAt={refreshedAt}
        />
      </CardContent>
    </Card>
  );
}

function MatchupList({
  title,
  entries,
  emptyHint,
  refreshedAt,
}: {
  title: string;
  entries: RankedMatchup[];
  emptyHint: string;
  refreshedAt: number;
}) {
  const { t } = useTranslation();
  return (
    <div>
      <h3 className="mb-2 text-sm text-muted-foreground">{title}</h3>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyHint}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {entries.map((entry) => {
            const sprite = getFighterById(entry.opponentFighterId);
            const sample: SampleMeta = {
              rawSampleSize: entry.totalMatches,
              eligibleDenominator: entry.totalMatches,
              knownFieldCoverage: 1,
              dateRange: null,
              refreshedAt,
              evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
              recencyTreatment: RECENCY_TREATMENT,
              confidenceTier: confidenceTierFor(entry.totalMatches),
            };
            return (
              <li key={entry.opponentFighterId} className="flex items-center gap-2">
                {sprite && <img src={sprite.url} alt="" className="size-10 object-contain" />}
                <div>
                  <div className="font-medium">
                    {sprite
                      ? localizedFighterName(entry.opponentFighterId, t)
                      : t('common.unknown')}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {entry.wins}-{entry.losses} &middot; {entry.ratio}% ({entry.totalMatches}){' '}
                    <SampleCue sample={sample} />
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
