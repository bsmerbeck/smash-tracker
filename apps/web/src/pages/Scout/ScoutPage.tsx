import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import {
  scoutIdentityKey,
  type ScoutReportData,
  type ScoutReportRecord,
  type ScoutSource,
} from '@smash-tracker/shared';
import { ApiError } from '@/lib/api';
import { useScoutPlayer } from '@/hooks/useScoutPlayer';
import { useMatches } from '@/hooks/useMatches';
import { useGenerateReport, useReportsConfig, useScoutReportsList } from '@/hooks/useScoutReports';
import { useCredits } from '@/hooks/useBilling';
import { useParryggStatus } from '@/hooks/useParrygg';
import { getOpponentProfile } from '@/lib/stats';
import { Button } from '@/components/ui/button';
import { ScoutSearchForm } from './components/ScoutSearchForm';
import { ScoutReportHeader } from './components/ScoutReportHeader';
import { ScoutCharactersCard } from './components/ScoutCharactersCard';
import { ScoutStagesCard } from './components/ScoutStagesCard';
import { ScoutRecentEventsCard } from './components/ScoutRecentEventsCard';
import { ScoutCommonOpponentsCard } from './components/ScoutCommonOpponentsCard';
import { ScoutMatchupAdvisorCard } from './components/ScoutMatchupAdvisorCard';
import { YourHistoryStrip } from './components/YourHistoryStrip';
import { ScoutAiReportCard } from './components/ScoutAiReportCard';
import { ScoutReportHistorySelector } from './components/ScoutReportHistorySelector';
import { ScoutPastReportsCard } from './components/ScoutPastReportsCard';
import { BuyCreditsDialog } from '@/components/billing/BuyCreditsDialog';

function describeError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 404) {
      return "We couldn't find a start.gg player for that query. Double-check the URL, slug, or player id.";
    }
    if (error.status === 400) {
      return error.message || "That doesn't look like a start.gg profile URL, slug, or player id.";
    }
    if (error.status === 429) {
      return 'start.gg is rate-limiting requests right now. Try again in a minute.';
    }
    return error.message || fallback;
  }
  return fallback;
}

/** How many times to re-poll `useCredits` after a successful checkout return (webhook delivery can lag the redirect). */
const CREDITS_POLL_ATTEMPTS = 5;
const CREDITS_POLL_INTERVAL_MS = 2000;

function formatUsd(amountCents: number): string {
  return (amountCents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

/**
 * `/scout` — "opponent research before bracket": scout ANY start.gg player
 * (not just linked accounts) by pasting their profile URL, slug, or numeric
 * player id. The API resolves the identity and aggregates their public SSBU
 * set history server-side into a `ScoutReportData` (see
 * apps/api/src/startgg/scout.ts); this page just renders it.
 *
 * When the scouted gamer tag matches an opponent already in the caller's own
 * match history, a "Your History vs Them" strip surfaces the existing
 * head-to-head record (same data the Scouting page shows) above the public
 * report.
 *
 * V7-B: when AI reports are enabled for the signed-in user
 * (`useReportsConfig`), a "Generate AI report" button appears once a scout
 * result is on screen. The feature is completely invisible when disabled —
 * no button, no past-reports card, nothing rendered at all.
 *
 * V7-B.1: reports are stored server-side, so a refresh or a fresh scout no
 * longer loses them. Once a scout result is on screen, the stored reports
 * list (`useScoutReportsList`) is checked for a report matching this exact
 * scouted player (by start.gg player id — the stable identity field on
 * `scoutPlayerIdentitySchema`); if one exists, its most recent report renders
 * automatically with no click needed, and the generate button becomes
 * "Regenerate report". The past-reports card excludes this player's own
 * reports (they're already shown above) and only lists OTHER players'.
 *
 * V7-C: report generation costs one credit for everyone except allowlisted
 * uids. The billing UI keys off the `GET /api/billing/credits` query (live,
 * short-TTL) rather than `reportsConfig.billingEnabled` (cached long): a
 * small indicator shows "Free access" or "N credits", and when the user
 * isn't free and packs are purchasable a "Buy credits" affordance plus a
 * pack-pricing line appear next to the button. `BuyCreditsDialog` opens from
 * that affordance and automatically when generation answers 402. On return
 * from Stripe Checkout (`?billing=success`/`?billing=cancelled`), a banner
 * surfaces the outcome and — on success — the credits query is re-polled for
 * a few seconds since webhook delivery can lag the redirect.
 */
export function ScoutPage() {
  const scout = useScoutPlayer();
  const { data: matches = [] } = useMatches();
  const reportsConfig = useReportsConfig();
  const generateReport = useGenerateReport();
  const pastReports = useScoutReportsList();
  const credits = useCredits();
  const parryggStatus = useParryggStatus();
  // parry.gg toggle is hidden entirely when the integration isn't configured
  // on this deployment (V9-B Feature 4) — an unconfigured server answers 503
  // for every /api/integrations/parrygg/* route, which surfaces here as a
  // query error rather than a normal { linked: false } response. Fails
  // CLOSED (hides the toggle) for anything other than a confirmed successful
  // status fetch, rather than assuming enabled on an ambiguous error.
  const parryggEnabled = parryggStatus.isSuccess;

  const [lastQuery, setLastQuery] = useState<{ query: string; source: ScoutSource } | null>(null);
  const [selectedRecord, setSelectedRecord] = useState<ScoutReportRecord | null>(null);
  const [buyCreditsOpen, setBuyCreditsOpen] = useState(false);
  // V9-B Feature 1: which of the CURRENT player's stored reports the history
  // selector has picked (index into the reverse-chronological list from
  // GET /api/reports); null means "use the newest" (the default).
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);

  const report: ScoutReportData | undefined = scout.data;
  const aiReportsEnabled = reportsConfig.data?.enabled ?? false;
  // Billing UI keys off the credits query, NOT reportsConfig.billingEnabled:
  // the credits query (`GET /api/billing/credits`) has a short staleTime and
  // reflects live Stripe state, whereas reportsConfig is cached long and can
  // lag behind Stripe being turned on server-side — which would leave a
  // charged user (402) with no way to buy. `freeAccess` still falls back to
  // reportsConfig so the owner's indicator renders before credits loads.
  const creditsData = credits.data;
  const freeAccess = creditsData?.freeAccess ?? reportsConfig.data?.freeAccess ?? false;
  const availablePacks = creditsData?.packs ?? [];
  const canBuyCredits = !freeAccess && availablePacks.length > 0;
  const lastGenerateWas402 =
    generateReport.error instanceof ApiError && generateReport.error.status === 402;

  // Surface the Stripe Checkout return trip (the API redirects back with a
  // `billing` query param) and strip it from the URL once handled.
  const [searchParams, setSearchParams] = useSearchParams();
  const announcedBilling = useRef(false);
  useEffect(() => {
    const outcome = searchParams.get('billing');
    if (!outcome || announcedBilling.current) {
      return;
    }
    announcedBilling.current = true;
    if (outcome === 'success') {
      toast.success("Payment received — your credits will land shortly if they haven't already.");
      let attempts = 0;
      const poll = setInterval(() => {
        attempts += 1;
        void credits.refetch();
        if (attempts >= CREDITS_POLL_ATTEMPTS) {
          clearInterval(poll);
        }
      }, CREDITS_POLL_INTERVAL_MS);
    } else if (outcome === 'cancelled') {
      toast('Checkout cancelled — no charge was made.');
    }
    setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- credits.refetch is stable per render but not a dep we want to re-trigger this effect on
  }, [searchParams, setSearchParams]);

  const yourHistory = useMemo(() => {
    if (!report) {
      return null;
    }
    const needle = report.player.gamerTag.trim().toLowerCase();
    if (!needle) {
      return null;
    }
    return getOpponentProfile(matches, needle);
  }, [matches, report]);

  // Every stored report for the CURRENTLY scouted player, newest first —
  // matched via `scoutIdentityKey` (source-aware: a start.gg player id and a
  // parry.gg parryUserId never collide, and pre-V9-B records with no
  // `source` at all still match correctly since the key defaults to
  // 'startgg'). Newest-first is already guaranteed by GET /api/reports.
  const reportsForCurrentPlayer = useMemo(() => {
    if (!report) {
      return [];
    }
    const needle = scoutIdentityKey(report.player);
    return (pastReports.data ?? []).filter((record) => scoutIdentityKey(record.player) === needle);
  }, [pastReports.data, report]);

  // V9-B Feature 1: the history selector picks an index into
  // `reportsForCurrentPlayer`; out-of-range (e.g. the list shrank) falls back
  // to the newest (index 0).
  const storedRecordForCurrentPlayer =
    reportsForCurrentPlayer[historyIndex ?? 0] ?? reportsForCurrentPlayer[0] ?? null;

  const handleSubmit = (query: string, source: ScoutSource) => {
    setSelectedRecord(null);
    setHistoryIndex(null);
    generateReport.reset();
    setLastQuery({ query, source });
    scout.mutate({ query, source });
  };

  const handleGenerateReport = () => {
    if (!lastQuery) {
      return;
    }
    setSelectedRecord(null);
    setHistoryIndex(null);
    generateReport.mutate(lastQuery, {
      onError: (error) => {
        if (error instanceof ApiError && error.status === 402) {
          setBuyCreditsOpen(true);
        }
      },
      onSuccess: () => {
        void credits.refetch();
      },
    });
  };

  // The record to actually render: a freshly generated report takes priority
  // over a previously-selected past report (a new generation replaces what's
  // on screen), which in turn takes priority over the stored report already
  // on file for this exact player (V7-B.1 persistence), which in turn takes
  // priority over nothing.
  const displayedRecord =
    generateReport.data ?? selectedRecord ?? storedRecordForCurrentPlayer ?? null;

  // Other players' past reports — this player's own reports are already
  // shown automatically above, so they're excluded here to avoid duplication.
  // Same source-aware key as `reportsForCurrentPlayer` above.
  const currentPlayerKey = report ? scoutIdentityKey(report.player) : null;
  const otherPastReports = (pastReports.data ?? []).filter(
    (record) => scoutIdentityKey(record.player) !== currentPlayerKey,
  );

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Scout a Player</h1>

      <ScoutSearchForm
        onSubmit={handleSubmit}
        isPending={scout.isPending}
        parryggEnabled={parryggEnabled}
      />

      {scout.isError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {describeError(scout.error, 'Something went wrong while scouting that player.')}
        </div>
      )}

      {report && (
        <div className="flex flex-col gap-4">
          <ScoutReportHeader report={report} />
          {yourHistory && <YourHistoryStrip profile={yourHistory} />}

          {aiReportsEnabled && (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  onClick={handleGenerateReport}
                  disabled={generateReport.isPending}
                  className="w-fit"
                >
                  <Sparkles className={generateReport.isPending ? 'animate-spin' : ''} />
                  {generateReport.isPending
                    ? 'Generating report…'
                    : displayedRecord
                      ? 'Regenerate report'
                      : 'Generate AI report'}
                </Button>

                {(freeAccess || creditsData) && (
                  <span className="text-sm text-muted-foreground">
                    {freeAccess ? 'Free access' : `${creditsData?.balance ?? 0} credits`}
                  </span>
                )}
                {canBuyCredits && (
                  <Button
                    type="button"
                    variant="link"
                    className="h-auto p-0 text-sm"
                    onClick={() => setBuyCreditsOpen(true)}
                  >
                    Buy credits
                  </Button>
                )}
              </div>
              {/* Explain what a report costs and the available packs, right by
                  the button, so the pricing is visible before checkout. */}
              {canBuyCredits && (
                <p className="text-sm text-muted-foreground">
                  Each report costs 1 credit.{' '}
                  {availablePacks
                    .map((pack) => `${pack.label} for ${formatUsd(pack.amountCents)}`)
                    .join(' · ')}
                  .
                </p>
              )}
              {generateReport.isPending && (
                <p className="text-sm text-muted-foreground">
                  Generating report — this usually takes a minute or two.
                </p>
              )}
              {/* A 402 auto-opens the buy dialog; this leaves a persistent cue
                  after it's dismissed rather than a scary red error. */}
              {lastGenerateWas402 && canBuyCredits && !generateReport.isPending && (
                <p className="text-sm text-muted-foreground">
                  You're out of credits.{' '}
                  <Button
                    type="button"
                    variant="link"
                    className="h-auto p-0 text-sm"
                    onClick={() => setBuyCreditsOpen(true)}
                  >
                    Buy a pack
                  </Button>{' '}
                  to generate this report.
                </p>
              )}
              {generateReport.isError &&
                !(
                  generateReport.error instanceof ApiError && generateReport.error.status === 402
                ) && (
                  <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
                    {describeError(
                      generateReport.error,
                      'Something went wrong while generating the report.',
                    )}
                  </div>
                )}
            </div>
          )}

          {/* V9-B Feature 1: only rendered when this player has MORE THAN ONE
              stored report — a single report needs no navigation, it's just
              shown directly via storedRecordForCurrentPlayer below. */}
          {!generateReport.data && !selectedRecord && reportsForCurrentPlayer.length > 1 && (
            <ScoutReportHistorySelector
              reports={reportsForCurrentPlayer}
              index={historyIndex ?? 0}
              onChange={setHistoryIndex}
            />
          )}

          {displayedRecord && <ScoutAiReportCard record={displayedRecord} />}

          <ScoutMatchupAdvisorCard scoutedCharacters={report.characters} matches={matches} />

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <ScoutCharactersCard characters={report.characters} />
            <ScoutStagesCard stages={report.stages} />
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <ScoutRecentEventsCard events={report.recentEvents} />
            <ScoutCommonOpponentsCard opponents={report.commonOpponents} />
          </div>
        </div>
      )}

      {aiReportsEnabled && otherPastReports.length > 0 && (
        <ScoutPastReportsCard
          reports={otherPastReports}
          onSelect={(record) => setSelectedRecord(record)}
        />
      )}

      {!report && !scout.isError && !scout.isPending && (
        <div className="flex items-center justify-center rounded-lg border border-dashed p-16 text-center text-sm text-muted-foreground">
          {parryggEnabled
            ? 'Paste a start.gg or parry.gg profile URL, slug/tag, or player id above to pull up their public tournament history.'
            : 'Paste a start.gg profile URL, slug, or player id above to pull up their public tournament history.'}
        </div>
      )}

      {canBuyCredits && (
        <BuyCreditsDialog
          open={buyCreditsOpen}
          onOpenChange={setBuyCreditsOpen}
          packs={availablePacks}
        />
      )}
    </div>
  );
}
