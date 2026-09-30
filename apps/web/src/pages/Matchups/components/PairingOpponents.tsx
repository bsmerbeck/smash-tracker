import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { Match } from '@smash-tracker/shared';
import { confidenceTierFor } from '@smash-tracker/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { BoundedList, LIST_CAP } from '@/components/analytics/BoundedList';
import { DrillableRow, DrillableRowChevron } from '@/components/DrillableRow';
import { Record } from '@/components/analytics/Record';
import { DeltaChip } from '@/components/analytics/DeltaChip';
import { deltaChipView } from '@/components/analytics/deltaChipView';
import { SetStrip, type SetStripItem } from '@/components/charts/FormStrip';
import { useSubjectPath } from '@/hooks/useSubjectPath';
import { buildDrillDownSearch } from '@/lib/drillDownParams';
import { formatMonthSpan } from '@/lib/dateSpan';
import {
  buildOpponentLedger,
  LEDGER_MAX_SETS,
  type OpponentLedgerRow,
} from '../lib/opponentLedger';

interface LedgerRowProps {
  row: OpponentLedgerRow;
  fighterId: number;
  opponentFighterId: number;
  t: TFunction;
  locale: string;
  subjectPath: (personalPath: string) => string;
}

/**
 * Plan 39.1-45 (sketch 003 C `renderC` `led`, CSS 278-289; owner decision
 * 2026-09-25): one rivalry-ledger row — line 1 is the tag, the record with
 * the sets record and the confidence glyph, with the last-12-months chip in
 * the right column; line 2 is the per-set strip (up = set won) and the first
 * → last month span. The whole row is one Phase 38 `DrillableRow` to the
 * opponent hub with `?fighter=&vs=` pre-applied.
 *
 * Below a 420px row container (sketch `@container led (max-width:419px)`) the
 * grid is one column: the chip sits under line 1, left-aligned, and an empty
 * chip cell is hidden so it never holds a phantom row gap.
 */
function LedgerRow({ row, fighterId, opponentFighterId, t, locale, subjectPath }: LedgerRowProps) {
  const search = buildDrillDownSearch({
    fighterId,
    vsFighterId: opponentFighterId,
  }).toString();
  const to = subjectPath(`/opponents/${encodeURIComponent(row.tag)}${search ? `?${search}` : ''}`);
  const recordText = `${row.record.wins}–${row.record.losses}`;
  const tier = confidenceTierFor(row.record.total);
  const cueLabel = tier
    ? t(`shared.evidence.sampleCueGlyph.${tier}`, { count: row.record.total })
    : '';

  // PD-45-1: the chip is this opponent's D-15 window vs this opponent's all
  // time — omitted (never invented) when the window holds no games, and by
  // `deltaChipView` when the window IS the record (collapsed). The card meta
  // names the window, so the chip does not repeat it (D-06).
  const chip =
    row.recent.total > 0
      ? deltaChipView({
          state: row.classification.state,
          deltaPoints: row.classification.deltaPoints,
          recentGames: row.recent.total,
          horizon: 'last30',
          horizonOwnedByParent: true,
          t,
        })
      : null;

  const shownWon = row.sets.filter((set) => set.won).length;
  const ticks: SetStripItem[] = row.sets.map((set) => ({
    key: set.key,
    won: set.won,
    label: `${t('analytics.strip.setAria', {
      opponent: row.tag,
      record: `${set.wins}–${set.losses}`,
    })} · ${new Date(set.lastGameMs).toLocaleDateString(locale)}`,
  }));
  const trimmed = row.setsTotal > row.sets.length;

  return (
    <li
      data-slot="pairing-opponent-row"
      className="@container/pairing-opponent-row relative rounded-md px-1.5 py-2 hover:bg-accent"
    >
      <DrillableRow
        as="overlay"
        to={to}
        ariaLabel={t('shared.drillableRow.aria', { subject: row.tag, context: recordText })}
      />
      <div
        data-slot="pairing-opponent-body"
        className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 @max-[419px]/pairing-opponent-row:grid-cols-[minmax(0,1fr)]"
      >
        <div
          data-slot="pairing-opponent-who"
          className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5"
        >
          <span
            className="min-w-0 truncate text-base leading-5 font-semibold"
            title={row.tag.length > 0 ? row.tag : undefined}
            data-slot="pairing-opponent-tag"
          >
            {row.tag}
          </span>
          <span
            data-slot="pairing-opponent-record"
            className="text-sm leading-5 whitespace-nowrap tabular-nums text-muted-foreground"
          >
            <Record
              wins={row.record.wins}
              losses={row.record.losses}
              cue="none"
              emphasis
              className="[&>span:first-child]:text-foreground"
            />
            <span>{` · ${t('matchups.ledger.sets', { won: row.setsWon, lost: row.setsLost })}`}</span>
          </span>
          {tier && (
            <span
              role="img"
              aria-label={cueLabel}
              className="shrink-0 text-xs leading-5 whitespace-nowrap tabular-nums text-muted-foreground"
            >
              {tier === 'high' ? '●●●' : tier === 'medium' ? '●●○' : '●○○'}
            </span>
          )}
        </div>
        <span
          data-slot="pairing-opponent-chip"
          className="justify-self-end whitespace-nowrap empty:hidden @max-[419px]/pairing-opponent-row:justify-self-start"
        >
          {chip && (
            <DeltaChip
              {...chip}
              ariaLabel={t('analytics.dumbbell.rowAria', {
                label: row.tag,
                recentRecord: `${row.recent.wins}–${row.recent.losses}`,
                baselineRecord: recordText,
              })}
            />
          )}
        </span>
        <div
          data-slot="pairing-opponent-sets"
          className="col-span-full flex flex-wrap items-center gap-x-2 gap-y-1"
        >
          <SetStrip
            sets={ticks}
            ariaLabel={t('matchups.ledger.setsAria', {
              won: shownWon,
              lost: row.sets.length - shownWon,
            })}
          />
          <span
            data-slot="pairing-opponent-span"
            className="text-xs leading-4 tabular-nums text-muted-foreground"
          >
            {formatMonthSpan(row.firstMs, row.lastMs, locale, ' → ')}
          </span>
          {trimmed && (
            <span className="text-xs leading-4 tabular-nums text-muted-foreground">
              {t('matchups.ledger.trimmed', { shown: LEDGER_MAX_SETS, total: row.setsTotal })}
            </span>
          )}
          {/* The chevron rides the sets line's free right end (sketch C has none): a
              beside-the-body chevron costs a phone row 24px and wraps the glyph. */}
          <DrillableRowChevron className="ml-auto" />
        </div>
      </div>
    </li>
  );
}

/**
 * The By-opponent card (owner note 11, UI-SPEC §8.3; rebuilt by plan 39.1-45
 * on sketch 003 C's rivalry-ledger rows). Every row wraps in Phase 38's
 * `DrillableRow` — the same affordance grammar every other retrofitted
 * analytics surface uses — rather than a bespoke link. The tag renders
 * exactly as recorded (no `capitalize`, UI-SPEC §6.5 rule 5).
 *
 * `nowMs` is the page's one clock (`MatchupsPage`), so the ledger's
 * last-12-months window agrees with the hero's; absent, the card reads its
 * own mount time.
 *
 * `noInertRow.test.tsx` enumerates this surface (plan 39.1-21).
 */
export function PairingOpponents({
  matchupMatches,
  nowMs,
}: {
  matchupMatches: Match[];
  nowMs?: number;
}) {
  const { t, i18n } = useTranslation();
  const subjectPath = useSubjectPath();
  const [mountedAtMs] = useState(() => Date.now());
  const clockMs = nowMs ?? mountedAtMs;

  const ledger = useMemo(
    () => buildOpponentLedger({ matches: matchupMatches, nowMs: clockMs }),
    [matchupMatches, clockMs],
  );
  const fighterId = matchupMatches[0]?.fighter_id;
  const opponentFighterId = matchupMatches[0]?.opponent_id;
  const empty = (
    <p className="text-sm text-muted-foreground">{t('matchups.opponentSplit.empty')}</p>
  );

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <CardTitle>{t('matchups.opponentSplit.title')}</CardTitle>
        <p className="min-w-0 text-xs leading-4 text-muted-foreground tabular-nums">
          {t('matchups.ledger.meta')}
        </p>
      </CardHeader>
      <CardContent>
        {ledger.length === 0 || fighterId == null || opponentFighterId == null ? (
          empty
        ) : (
          <BoundedList
            cap={LIST_CAP}
            rows={ledger.map((row) => (
              <LedgerRow
                key={row.tag}
                row={row}
                fighterId={fighterId}
                opponentFighterId={opponentFighterId}
                t={t}
                locale={i18n.language}
                subjectPath={subjectPath}
              />
            ))}
            labels={{
              showAll: t('analytics.list.showAll', { count: ledger.length }),
              showFewer: t('analytics.list.showFewer'),
              showMore: t('analytics.list.showMore50'),
              terminus: t('analytics.list.allOpponents', { count: ledger.length }),
            }}
            empty={empty}
            terminusHref={subjectPath('/opponents')}
          />
        )}
      </CardContent>
    </Card>
  );
}
