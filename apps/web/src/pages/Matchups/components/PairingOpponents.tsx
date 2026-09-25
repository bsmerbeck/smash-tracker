import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { InsightState, Match } from '@smash-tracker/shared';
import { classify, confidenceTierFor, toRateValue } from '@smash-tracker/shared';
import { getOpponentRecords, type OpponentRecord } from '@/lib/stats';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { BoundedList, LIST_CAP } from '@/components/analytics/BoundedList';
import { DrillableRow, DrillableRowChevron } from '@/components/DrillableRow';
import { Record } from '@/components/analytics/Record';
import { RecordBar } from '@/components/charts/inlineMarks';
import { DeltaChip, type DeltaChipState } from '@/components/analytics/DeltaChip';
import { useSubjectPath } from '@/hooks/useSubjectPath';
import { buildDrillDownSearch } from '@/lib/drillDownParams';

/** `classify`'s seven-state honesty ladder -> `DeltaChip`'s six-state union — the SAME mapping `MatchWinLossCard.tsx` uses, duplicated per this codebase's small-helper convention (see `bestWorstMatchup.ts`'s doc comment on `groupByOpponentCharacter`). */
function deltaChipStateFor(state: InsightState, deltaPoints: number | null): DeltaChipState {
  if (state === 'trend' || state === 'suggestion') {
    return deltaPoints !== null && deltaPoints < 0 ? 'down' : 'up';
  }
  if (state === 'steady') return 'steady';
  if (state === 'thin' || state === 'thinRecent') return 'thin';
  if (state === 'collapsed') return 'collapsed';
  return 'none';
}

function deltaValueLabel(state: DeltaChipState, deltaPoints: number | null, t: TFunction): string {
  if (state === 'up') return t('analytics.record.deltaUp', { points: Math.abs(deltaPoints ?? 0) });
  if (state === 'down') {
    return t('analytics.record.deltaDown', { points: Math.abs(deltaPoints ?? 0) });
  }
  return t(`insights.chip.${state === 'none' ? 'thin' : state}`);
}

interface PairingOpponentRowProps {
  record: OpponentRecord;
  overallRate: { wins: number; losses: number; total: number; rate: number };
  fighterId: number;
  opponentFighterId: number;
  t: TFunction;
  subjectPath: (personalPath: string) => string;
}

function PairingOpponentRow({
  record,
  overallRate,
  fighterId,
  opponentFighterId,
  t,
  subjectPath,
}: PairingOpponentRowProps) {
  const thisOpponentRate = {
    wins: record.wins,
    losses: record.losses,
    total: record.total,
    rate: record.total > 0 ? record.wins / record.total : 0,
  };
  const { state, deltaPoints } = classify({
    recent: thisOpponentRate,
    baseline: overallRate,
    scoped: false,
    hasAction: false,
  });
  // WR-C01: `locked` (below the abstention floor) is a different honesty
  // tier than `thin`/`thinRecent` and has no `DeltaChip` representation —
  // omit the chip entirely rather than let it fall through to
  // `deltaChipStateFor`'s `'none'` default, which reads "Thin".
  const chipState = state === 'locked' ? null : deltaChipStateFor(state, deltaPoints);
  const tier = confidenceTierFor(record.total);
  const cueLabel = tier ? t(`shared.evidence.sampleCueGlyph.${tier}`, { count: record.total }) : '';

  const search = buildDrillDownSearch({
    fighterId,
    vsFighterId: opponentFighterId,
  }).toString();
  const to = subjectPath(
    `/opponents/${encodeURIComponent(record.opponent)}${search ? `?${search}` : ''}`,
  );
  const recordText = `${record.wins}–${record.losses}`;

  return (
    <li className="@container/pairing-opponent-row relative flex items-center gap-2 rounded-md p-2 hover:bg-accent">
      <DrillableRow
        as="overlay"
        to={to}
        ariaLabel={t('shared.drillableRow.aria', { subject: record.opponent, context: recordText })}
      />
      {/*
        Plan 39.1-32 (item 12, UI-SPEC §6.5 rules 1-3, §8.5 two-line
        precedent, §14.6 touch rows): below a 480px row container the tag
        owns its own line above a whole-token-wrapping metrics line — chosen
        over §8.3's literal "drop RecordBar then the record" because
        stacking keeps the record visible, keeps the tag readable, and keeps
        the touch row taller than 44px. The §6.5 priority drops (RecordBar
        below 300px, Record below 220px) remain the last resort at narrower
        row widths. Module-private to this file (not shared with Scout's
        FullAnalysisSection, OpponentTable or WhatTheyPlayTable).
      */}
      <div
        data-slot="pairing-opponent-body"
        className="flex min-w-0 flex-1 flex-col gap-1 @min-[480px]/pairing-opponent-row:flex-row @min-[480px]/pairing-opponent-row:items-center @min-[480px]/pairing-opponent-row:gap-2"
      >
        <span
          className="min-w-0 truncate @min-[480px]/pairing-opponent-row:flex-1"
          title={record.opponent.length > 0 ? record.opponent : undefined}
          data-slot="pairing-opponent-tag"
        >
          {record.opponent}
        </span>
        <div
          data-slot="pairing-opponent-metrics"
          className="flex flex-wrap items-center gap-x-2 gap-y-1 @min-[480px]/pairing-opponent-row:shrink-0 @min-[480px]/pairing-opponent-row:flex-nowrap"
        >
          <span className="shrink-0 whitespace-nowrap @max-[300px]/pairing-opponent-row:hidden">
            <RecordBar wins={record.wins} losses={record.losses} />
          </span>
          <span
            className="shrink-0 whitespace-nowrap @max-[220px]/pairing-opponent-row:hidden"
            title={recordText}
          >
            <Record wins={record.wins} losses={record.losses} cue="none" />
          </span>
          {chipState !== null && chipState !== 'collapsed' && (
            <span className="shrink-0 whitespace-nowrap">
              <DeltaChip
                state={chipState}
                valueLabel={deltaValueLabel(chipState, deltaPoints, t)}
                horizonOwnedByParent
                ariaLabel={t('analytics.dumbbell.rowAria', {
                  label: record.opponent,
                  recentRecord: recordText,
                  baselineRecord: `${overallRate.wins}–${overallRate.losses}`,
                })}
              />
            </span>
          )}
          {tier && (
            <span
              role="img"
              aria-label={cueLabel}
              className="shrink-0 whitespace-nowrap tabular-nums"
            >
              {tier === 'high' ? '●●●' : tier === 'medium' ? '●●○' : '●○○'}
            </span>
          )}
        </div>
      </div>
      <DrillableRowChevron />
    </li>
  );
}

/**
 * Ports the retired per-human-opponent split card (owner note 11, UI-SPEC
 * §8.3): the inert list becomes a bounded, drillable list. Every row wraps
 * in Phase 38's `DrillableRow` — the same affordance grammar every other
 * retrofitted analytics surface uses — rather than a bespoke link. The tag
 * renders exactly as recorded (the retired card's `capitalize` display
 * transform is removed, UI-SPEC §6.5 rule 5).
 *
 * NOTE for plan 39.1-21: this surface must be added to Phase 38's
 * no-inert-row enumeration (`noInertRow.test.tsx`) — 39.1-13 does not fork
 * that test itself (per this plan's own `<action>` instruction).
 *
 * Plan 39.1-32 (item 12, UI-SPEC §6.5 rules 1-3, §8.5 two-line row
 * precedent): below a 480px row container the tag owns its own line above a
 * whole-token-wrapping metrics line (record, RecordBar, delta chip,
 * confidence glyph) — preferred over §8.3's literal "drop RecordBar then
 * the record" because stacking keeps the record visible on a phone while
 * still giving the tag room to read in full. The §6.5 priority drops remain
 * the last resort at narrower row widths (RecordBar below 300px, Record
 * below 220px).
 */
export function PairingOpponents({ matchupMatches }: { matchupMatches: Match[] }) {
  const { t } = useTranslation();
  const subjectPath = useSubjectPath();

  const records = getOpponentRecords(matchupMatches).sort((a, b) => b.total - a.total);
  const fighterId = matchupMatches[0]?.fighter_id;
  const opponentFighterId = matchupMatches[0]?.opponent_id;
  const overallRate = toRateValue(matchupMatches);
  const empty = (
    <p className="text-sm text-muted-foreground">{t('matchups.opponentSplit.empty')}</p>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('matchups.opponentSplit.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        {records.length === 0 || fighterId == null || opponentFighterId == null ? (
          empty
        ) : (
          <BoundedList
            cap={LIST_CAP}
            rows={records.map((record) => (
              <PairingOpponentRow
                key={record.opponent}
                record={record}
                overallRate={overallRate}
                fighterId={fighterId}
                opponentFighterId={opponentFighterId}
                t={t}
                subjectPath={subjectPath}
              />
            ))}
            labels={{
              showAll: t('analytics.list.showAll', { count: records.length }),
              showFewer: t('analytics.list.showFewer'),
              showMore: t('analytics.list.showMore50'),
              terminus: t('analytics.list.allOpponents', { count: records.length }),
            }}
            empty={empty}
            terminusHref={subjectPath('/opponents')}
          />
        )}
      </CardContent>
    </Card>
  );
}
