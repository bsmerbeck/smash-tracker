import { useNavigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  confidenceTierFor,
  tierLevel,
  type TierSplitRow,
  type TierSplitStats,
  type TierWord,
} from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { CHART_TOKENS } from '@/components/charts/tokens';
import { DrillableRow } from '@/components/DrillableRow';
import { MUTED_LINK_TONE } from '@/components/analytics/linkTone';
import { Record } from '@/components/analytics/Record';
import { TierGlyph } from '@/components/analytics/tier/TierBadge';
import { TierCoverageLine } from '@/components/analytics/tier/TierCoverageLine';
import {
  buildTierFilterSearch,
  readTierFilterParams,
  TIER_FILTER_SIDE_PARAM,
} from '@/lib/tierFilterParams';

export interface ByTierCardProps {
  /** The split `buildTierSplitStats` produced for the page's current filters. */
  stats: TierSplitStats;
  /** Side events among the events the page shows, so the header can say how many the split leaves out (or took in). */
  sideEventCount: number;
  /** The account's overall win rate, 0 to 1, drawn as the reference tick; `null` below the abstention floor draws none. */
  overallRate: number | null;
}

/** The `overline` role (UI-SPEC §5). */
const OVERLINE =
  'text-[0.6875rem] leading-4 font-semibold tracking-wider text-muted-foreground uppercase';

const BAR_HEIGHT_PX = 8;
const BAR_TRACK_PX = 2;
const BAR_FILL_PX = 6;
const BAR_TICK_PX = 1;
const PERCENT = 100;

/**
 * The 0 to 100 rate bar (UI-SPEC §7.4): a 2px `--viz-context-strong` track, a
 * `--viz-series-1` fill, and the account's overall rate as a 1px
 * `--viz-context` tick. Decorative: the record beside it is the text, so it is
 * `aria-hidden`. `ComparisonBars` has no series-1 mode with a reference tick,
 * so this draws the same plain-DOM meter from the same chart tokens.
 */
function RateBar({ rate, overallRate }: { rate: number; overallRate: number | null }) {
  const pct = Math.max(0, Math.min(PERCENT, rate * PERCENT));
  return (
    <span
      data-slot="by-tier-bar"
      aria-hidden="true"
      className="relative block w-full"
      style={{ height: BAR_HEIGHT_PX }}
    >
      <span
        data-slot="by-tier-bar-track"
        className="absolute inset-x-0 top-1/2 block -translate-y-1/2"
        style={{ height: BAR_TRACK_PX, backgroundColor: CHART_TOKENS.deemphasisStrong }}
      />
      <span
        data-slot="by-tier-bar-fill"
        className="absolute top-1/2 left-0 block -translate-y-1/2 rounded-r-full"
        style={{ width: `${pct}%`, height: BAR_FILL_PX, backgroundColor: CHART_TOKENS.series1 }}
      />
      {overallRate != null && (
        <span
          data-slot="by-tier-bar-reference"
          className="absolute top-0 bottom-0 block"
          style={{
            left: `${Math.max(0, Math.min(PERCENT, overallRate * PERCENT))}%`,
            width: BAR_TICK_PX,
            backgroundColor: CHART_TOKENS.deemphasis,
          }}
        />
      )}
    </span>
  );
}

/** "26–7, 79%" for the accessible name: the rate only from the abstention floor up, as `Record` itself does. */
function recordSentence(row: TierSplitRow, numbers: Intl.NumberFormat): string {
  const base = `${numbers.format(row.wins)}–${numbers.format(row.losses)}`;
  return row.rate != null ? `${base}, ${Math.round(row.rate * PERCENT)}%` : base;
}

/**
 * TIER-03 / T-05 / T-06 (UI-SPEC §7.4): "how do I do at majors vs locals" at a
 * glance. One row per tier with at least one event in the current filters, in
 * vocabulary order; a tier under the abstention floor states its record and
 * how many more games it needs, and draws NO bar (never a rate off too few
 * games). The Unknown bucket is held apart in an inset, last, and is excluded
 * from the comparison. Every row is a `DrillableRow` into a `?tier=` FILTER of
 * this page (DD-12: a filter, never a game list), pushed as a navigation and
 * preserving the current setting / side params. The coverage line states how
 * much of the history the card covers, always.
 */
export function ByTierCard({ stats, sideEventCount, overallRate }: ByTierCardProps) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const locale = i18n.language;
  const numbers = new Intl.NumberFormat(locale);
  const filters = readTierFilterParams(searchParams);
  const sideIncluded = filters.side === 'include';
  const { rows, unknown, coverage } = stats;
  const allUnknown = rows.length === 0 && unknown != null;

  function tierDestination(word: TierWord): string {
    const params = buildTierFilterSearch(
      { tiers: [word], setting: filters.setting, side: filters.side },
      searchParams,
    );
    return `?${params.toString()}`;
  }

  function toggleSideEvents(): void {
    const params = new URLSearchParams(searchParams);
    if (sideIncluded) {
      params.delete(TIER_FILTER_SIDE_PARAM);
    } else {
      params.set(TIER_FILTER_SIDE_PARAM, 'include');
    }
    // A filter change replaces the URL (UI-SPEC §10.1), like the chips.
    navigate({ search: params.toString() }, { replace: true });
  }

  function rowAria(row: TierSplitRow): string {
    return t('tiers.byTier.rowAria', {
      tier: t(`tiers.label.${row.tier}`),
      record: recordSentence(row, numbers),
      count: row.total,
    });
  }

  /** A plain render helper, not a component: a component declared here would remount every render. */
  function renderRecord(row: TierSplitRow) {
    const confidence = confidenceTierFor(row.total);
    return (
      <Record
        wins={row.wins}
        losses={row.losses}
        cue="glyph"
        cueLabel={
          confidence ? t(`shared.evidence.sampleCueGlyph.${confidence}`, { count: row.total }) : ''
        }
        locale={locale}
        wrap
      />
    );
  }

  return (
    <Card data-slot="by-tier-card" className="gap-4 p-5 shadow-none">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className={OVERLINE}>{t('tiers.byTier.title')}</h2>
        <p
          data-slot="by-tier-meta"
          className="flex flex-wrap items-baseline gap-x-2 text-xs leading-4 text-muted-foreground"
        >
          <span>{t('tiers.byTier.sortNote')}</span>
          {sideEventCount > 0 && (
            <>
              <span aria-hidden="true">·</span>
              <span data-slot="by-tier-side-state">
                {t(sideIncluded ? 'tiers.coverage.sideIncluded' : 'tiers.coverage.sideExcluded', {
                  count: sideEventCount,
                })}
              </span>
              <Button
                type="button"
                variant="link"
                size="sm"
                className={`h-auto p-0 text-xs ${MUTED_LINK_TONE} underline`}
                onClick={toggleSideEvents}
              >
                {t(sideIncluded ? 'tiers.coverage.exclude' : 'tiers.coverage.include')}
              </Button>
            </>
          )}
        </p>
      </div>

      {rows.length > 0 && (
        <ul data-slot="by-tier-rows" className="flex flex-col divide-y divide-border">
          {rows.map((row) => {
            const word = t(`tiers.label.${row.tier}`);
            const abstains = row.rate == null;
            return (
              <li key={row.tier} data-slot="by-tier-row" data-tier={row.tier}>
                <DrillableRow
                  to={tierDestination(row.tier)}
                  ariaLabel={rowAria(row)}
                  className="pointer-coarse:min-h-11"
                >
                  <span className="flex flex-col gap-1 whitespace-normal">
                    <span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="shrink-0">
                          <TierGlyph level={tierLevel(row.tier)} />
                        </span>
                        {abstains ? (
                          <span data-slot="by-tier-abstain" className="text-muted-foreground">
                            {t('tiers.byTier.abstain', { tier: word, count: row.gamesNeeded })}
                          </span>
                        ) : (
                          <span className="shrink-0 font-medium">{word}</span>
                        )}
                      </span>
                      {row.total > 0 && renderRecord(row)}
                    </span>
                    {!abstains && row.rate != null && (
                      <RateBar rate={row.rate} overallRate={overallRate} />
                    )}
                  </span>
                </DrillableRow>
              </li>
            );
          })}
        </ul>
      )}

      {allUnknown && (
        <p data-slot="by-tier-all-unknown" className="text-sm text-muted-foreground">
          {t('tiers.byTier.allUnknown')}
        </p>
      )}

      {unknown != null && (
        <div data-slot="by-tier-unknown" className="rounded-md bg-muted/40 px-3">
          <div className="divide-y divide-border">
            <div data-slot="by-tier-row" data-tier="unknown">
              <DrillableRow
                to={tierDestination('unknown')}
                ariaLabel={rowAria(unknown)}
                className="pointer-coarse:min-h-11"
              >
                <span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm whitespace-normal">
                  <span className="shrink-0 font-medium text-muted-foreground">
                    {t('tiers.label.unknown')}
                  </span>
                  <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    {unknown.total > 0 && renderRecord(unknown)}
                    <span data-slot="by-tier-excluded" className="text-xs text-muted-foreground">
                      {t('tiers.byTier.excluded')}
                    </span>
                  </span>
                </span>
              </DrillableRow>
            </div>
          </div>
        </div>
      )}

      <TierCoverageLine coverage={coverage} />
    </Card>
  );
}
