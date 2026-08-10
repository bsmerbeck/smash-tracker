import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import {
  RESEARCH_EXCLUDED_OUTCOME_CLASSIFICATIONS,
  normalizeResearchClassificationCounts,
  normalizeResearchCounters,
  normalizeResearchNamedGaps,
  type ResearchClassificationCounts,
  type ResearchCounters,
  type ResearchCoveragePlayerSection,
  type ResearchCoverageResponse,
  type ResearchDateCoverage,
  type ResearchExcludedOutcomeClassification,
  type ResearchNamedGaps,
} from '@smash-tracker/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useDataCoverage } from '@/hooks/useDataCoverage';

const COUNT_FIELDS = [
  'discoveredAllGames',
  'discoveredEligible',
  'imported',
  'skipped',
  'unresolved',
  'corrected',
] as const;

const GAP_FIELDS = [
  'unknownCharacter',
  'unknownStage',
  'missingGameDetail',
  'missingCompletedAt',
  'unknownOnlineContext',
  'unknownVideogame',
  'unsafeProviderKey',
] as const;

/**
 * Provider-dead-page carve-out (30-CONTEXT.md, decided by Codex advisor as
 * product-owner proxy): these two live on `ResearchCounters` (they fold
 * into `totals` exactly like every other counter — see
 * `packages/shared/src/researchIngestion.ts`), but the panel renders them
 * as NAMED-GAP rows, in the same `coaching.research.coverage.gaps.*` key
 * family as `GAP_FIELDS` above, because that is what they mean to a
 * reader: start.gg confirmed it has no more data for this page range, not
 * a defect in what this system captured.
 */
const PROVIDER_UNAVAILABLE_FIELDS = [
  'providerUnavailablePages',
  'providerUnavailableRowEstimate',
] as const;

/** Maps a `RESEARCH_EXCLUDED_OUTCOME_CLASSIFICATIONS` member to its i18n key — `no-game-detail` cannot be a JSON object key itself, so this is the one translation site. */
const EXCLUDED_LABEL_KEYS: Record<ResearchExcludedOutcomeClassification, string> = {
  dq: 'excluded.dq',
  bye: 'excluded.bye',
  walkover: 'excluded.walkover',
  'no-game-detail': 'excluded.noGameDetail',
};

/**
 * The app's existing locale-aware date formatting convention
 * (`ScoutingHeader.tsx`, `TournamentHistory.tsx`): `toLocaleDateString`
 * passed the active i18n language. The members this reads are all
 * epoch-MILLISECOND by contract (review C-M3) — never divided or multiplied
 * here.
 */
function formatEpochMs(ms: number, language: string): string {
  return new Date(ms).toLocaleDateString(language);
}

function CountRows({
  counters,
  testidPrefix,
  t,
}: {
  counters: ResearchCounters;
  testidPrefix: string;
  t: TFunction;
}) {
  const normalized = normalizeResearchCounters(counters);
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
      {COUNT_FIELDS.map((field) => (
        <div
          key={field}
          data-testid={`${testidPrefix}-count-${field}`}
          className="flex items-center justify-between gap-2"
        >
          <dt className="text-muted-foreground">
            {t(`coaching.research.coverage.counts.${field}`)}
          </dt>
          <dd className="font-medium">{normalized[field]}</dd>
        </div>
      ))}
    </dl>
  );
}

function DateSpanRow({
  dateCoverage,
  t,
  language,
  testid,
}: {
  dateCoverage: ResearchDateCoverage;
  t: TFunction;
  language: string;
  testid: string;
}) {
  const unknown = t('coaching.research.coverage.dateCoverage.unknown');
  const earliest =
    dateCoverage.earliestSetAtMs != null
      ? formatEpochMs(dateCoverage.earliestSetAtMs, language)
      : unknown;
  const latest =
    dateCoverage.latestSetAtMs != null
      ? formatEpochMs(dateCoverage.latestSetAtMs, language)
      : unknown;
  return (
    <p data-testid={testid} className="text-sm text-muted-foreground">
      {t('coaching.research.coverage.dateCoverage.label')}: {earliest} – {latest}
    </p>
  );
}

function GapsSection({
  gaps,
  counters,
  t,
  testid,
}: {
  gaps: ResearchNamedGaps;
  /** Provider-dead-page carve-out (30-CONTEXT.md): the source of `PROVIDER_UNAVAILABLE_FIELDS`'s rows. Optional so a caller with no counters in hand renders the ordinary gap rows unchanged. */
  counters?: ResearchCounters;
  t: TFunction;
  testid: string;
}) {
  const normalized = normalizeResearchNamedGaps(gaps);
  const normalizedCounters = normalizeResearchCounters(counters);
  const nonZero = GAP_FIELDS.filter((field) => (normalized[field] ?? 0) > 0);
  const nonZeroProviderUnavailable = PROVIDER_UNAVAILABLE_FIELDS.filter(
    (field) => (normalizedCounters[field] ?? 0) > 0,
  );
  const hasAnyGap = nonZero.length > 0 || nonZeroProviderUnavailable.length > 0;
  return (
    <div data-testid={testid} className="text-sm">
      <h4 className="font-semibold">{t('coaching.research.coverage.gaps.title')}</h4>
      {!hasAnyGap ? (
        <p className="text-muted-foreground">{t('coaching.research.coverage.gaps.none')}</p>
      ) : (
        <ul>
          {nonZero.map((field) => (
            <li key={field} className="flex justify-between gap-2">
              <span className="text-muted-foreground">
                {t(`coaching.research.coverage.gaps.${field}`)}
              </span>
              <span className="font-medium">{normalized[field]}</span>
            </li>
          ))}
          {nonZeroProviderUnavailable.map((field) => (
            <li
              key={field}
              data-testid={`${testid}-${field}`}
              className="flex justify-between gap-2"
            >
              <span className="text-muted-foreground">
                {t(`coaching.research.coverage.gaps.${field}`)}
              </span>
              <span className="font-medium">{normalizedCounters[field]}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ExcludedSection({
  classificationCounts,
  t,
}: {
  classificationCounts: ResearchClassificationCounts;
  t: TFunction;
}) {
  const normalized = normalizeResearchClassificationCounts(classificationCounts);
  return (
    <div data-testid="data-coverage-excluded" className="rounded-md border p-3 text-sm">
      <h4 className="font-semibold">{t('coaching.research.coverage.excluded.title')}</h4>
      <p className="text-muted-foreground">
        {t('coaching.research.coverage.excluded.explanation')}
      </p>
      <ul className="mt-2">
        {RESEARCH_EXCLUDED_OUTCOME_CLASSIFICATIONS.map((classification) => (
          <li
            key={classification}
            data-testid={`data-coverage-excluded-${classification}`}
            className="flex justify-between gap-2"
          >
            <span className="text-muted-foreground">
              {t(`coaching.research.coverage.${EXCLUDED_LABEL_KEYS[classification]}`)}
            </span>
            <span className="font-medium">{normalized[classification]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PlayerSection({
  playerId,
  section,
  t,
  language,
}: {
  playerId: string;
  section: ResearchCoveragePlayerSection;
  t: TFunction;
  language: string;
}) {
  const testidPrefix = `data-coverage-player-${playerId}`;
  return (
    <div data-testid={testidPrefix} className="rounded-md border p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">
          {t('coaching.research.coverage.players.playerLabel', { playerId })}
        </h3>
        <span data-testid={`${testidPrefix}-as-of`} className="text-xs text-muted-foreground">
          {t('coaching.research.coverage.players.asOf', {
            date: formatEpochMs(section.asOfMs, language),
          })}
        </span>
      </div>
      <CountRows counters={section.counters} testidPrefix={testidPrefix} t={t} />
      <DateSpanRow
        dateCoverage={section.dateCoverage}
        t={t}
        language={language}
        testid={`${testidPrefix}-span`}
      />
      <GapsSection
        gaps={section.namedGaps}
        counters={section.counters}
        t={t}
        testid={`${testidPrefix}-gaps`}
      />
    </div>
  );
}

function NeverRunRow({ playerId, t }: { playerId: string; t: TFunction }) {
  return (
    <div
      data-testid={`data-coverage-player-${playerId}-never-run`}
      className="rounded-md border border-dashed p-3 text-sm text-muted-foreground"
    >
      <span className="font-medium text-foreground">
        {t('coaching.research.coverage.players.playerLabel', { playerId })}
      </span>{' '}
      {t('coaching.research.coverage.players.neverRun')}
    </div>
  );
}

/**
 * Phase 30.1 Plan 05 (WKSP-01A, review H5/C2-H2): the presentational body
 * shared by BOTH the admin-only research-tenant panel (`DataCoveragePanel`
 * below, via `useDataCoverage`) and the self-only in-account panel
 * (`SelfDataCoveragePanel`, via `useSelfDataCoverage`) — one render, two
 * data sources, so the two surfaces can never drift. Extracted verbatim
 * from the former `DataCoveragePanel` body; every `coaching.research.
 * coverage.*` i18n key and every `data-coverage-*` test id is unchanged.
 *
 * Takes the raw `ResearchCoverageResponse | null` plus the caller's
 * already-computed `hasCompletedRun` (both callers derive this the same
 * way: `data?.coverage != null`) rather than re-deriving it here, so a
 * caller with a different "has this ever run" rule (there is none today,
 * but the signature does not assume one) stays free to pass its own.
 */
export function DataCoveragePanelView({
  data,
  hasCompletedRun,
}: {
  data: ResearchCoverageResponse | null;
  hasCompletedRun: boolean;
}) {
  const { t, i18n } = useTranslation();
  const title = t('coaching.research.coverage.title');
  const language = i18n.language;
  const snapshot = data?.coverage ?? null;
  const confirmedPlayerIds = data?.confirmedPlayerIds ?? [];
  const unresolvedCandidateCount = data?.unresolvedCandidateCount ?? 0;
  const activeRun = data?.activeRun ?? null;

  return (
    <Card role="region" aria-label={title} data-testid="data-coverage-panel" className="mb-4">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle>{title}</CardTitle>
        {snapshot && (
          <span data-testid="data-coverage-as-of" className="text-xs text-muted-foreground">
            {t('coaching.research.coverage.asOf', {
              date: formatEpochMs(snapshot.asOfMs, language),
            })}
          </span>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!hasCompletedRun || !snapshot ? (
          <div>
            <p data-testid="data-coverage-no-run" className="text-sm text-muted-foreground">
              {t('coaching.research.coverage.noCompletedRun')}
            </p>
            {activeRun && (
              <p data-testid="data-coverage-active-run" className="text-sm text-muted-foreground">
                {t('coaching.research.coverage.activeRunInProgress', {
                  playerId: activeRun.playerId,
                })}
              </p>
            )}
          </div>
        ) : (
          <>
            <div data-testid="data-coverage-totals" className="rounded-md border bg-muted/30 p-3">
              <h3 className="text-sm font-semibold">
                {t('coaching.research.coverage.totals.title')}
              </h3>
              <p className="text-sm text-muted-foreground">
                {t('coaching.research.coverage.totals.explanation')}
              </p>
              <CountRows counters={snapshot.totals.counters} testidPrefix="data-coverage" t={t} />
              <DateSpanRow
                dateCoverage={snapshot.totals.dateCoverage}
                t={t}
                language={language}
                testid="data-coverage-span"
              />
              <GapsSection
                gaps={snapshot.totals.namedGaps}
                counters={snapshot.totals.counters}
                t={t}
                testid="data-coverage-gaps"
              />
            </div>

            <div className="flex flex-col gap-3">
              <h3 className="text-sm font-semibold">
                {t('coaching.research.coverage.players.title')}
              </h3>
              {Object.keys(snapshot.players)
                .sort()
                .map((playerId) => (
                  <PlayerSection
                    key={playerId}
                    playerId={playerId}
                    section={snapshot.players[playerId]!}
                    t={t}
                    language={language}
                  />
                ))}
              {[...confirmedPlayerIds]
                .filter((playerId) => !snapshot.players[playerId])
                .sort()
                .map((playerId) => (
                  <NeverRunRow key={playerId} playerId={playerId} t={t} />
                ))}
            </div>

            <ExcludedSection classificationCounts={snapshot.totals.classificationCounts} t={t} />

            {unresolvedCandidateCount > 0 && (
              <p data-testid="data-coverage-identity" className="text-sm text-muted-foreground">
                {t('coaching.research.coverage.identity.unresolvedCandidates', {
                  count: unresolvedCandidateCount,
                })}{' '}
                {t('coaching.research.coverage.identity.neverBackfilled')}
              </p>
            )}

            <p data-testid="data-coverage-vod-note" className="text-xs text-muted-foreground">
              {t('coaching.research.coverage.vodUrl.note')}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Phase 30 (start.gg Lossless Ingestion & Four-Player Coverage Audit,
 * ING-04/ING-05/WKSP-01A, D-14/D-15, plan 30-06): the admin-only completeness
 * surface, mounted directly under `ResearchSnapshotBanner` in
 * `ClientWorkspaceLayout`. Takes NO props and consumes `useDataCoverage()`
 * itself, mirroring `ResearchSnapshotBanner`'s self-contained shape — a page
 * can never opt out by forgetting to render it, because no page renders it
 * directly.
 *
 * Renders nothing on an ordinary workspace, while the kind lookup or the
 * coverage query is pending, or when the server answers the research
 * family's uniform 404 (`isForbidden`) — that 404 means "not for you" and
 * must never be rendered as a failure (T-30-06-01). A REAL failure (any
 * other error) renders a localized inline affordance rather than a blank
 * panel.
 *
 * A research workspace holds MULTIPLE confirmed start.gg player IDs — the
 * entire MkLeo/Sparg0 pattern this milestone exists to cover — and a
 * backfill run covers exactly one of them at a time. A single flat count
 * block would make one player's coverage look like the workspace's, which
 * is the same misreading the server-side whole-node snapshot used to make
 * literally true (review C2-H3). Rendering the workspace ROLLUP and the
 * per-player sections together, plus a not-yet-backfilled row for every
 * confirmed id with no section yet, is what makes "which player is this
 * number about" unambiguous.
 *
 * Phase 30.1 Plan 05: the render body now lives in the shared
 * `DataCoveragePanelView` above — this wrapper's own job is unchanged
 * (research-scoped gating + error handling via `useDataCoverage`).
 */
export function DataCoveragePanel() {
  const { t } = useTranslation();
  const { isResearch, isPending, isError, isForbidden, hasCompletedRun, data } = useDataCoverage();

  if (!isResearch || isPending || isForbidden) {
    return null;
  }

  if (isError) {
    const title = t('coaching.research.coverage.title');
    return (
      <Card role="region" aria-label={title} data-testid="data-coverage-panel" className="mb-4">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <CardContent>
          <p data-testid="data-coverage-load-error" className="text-sm text-destructive">
            {t('coaching.research.coverage.loadError')}
          </p>
        </CardContent>
      </Card>
    );
  }

  return <DataCoveragePanelView data={data} hasCompletedRun={hasCompletedRun} />;
}
