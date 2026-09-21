import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { Match, RosterFighterEntry } from '@smash-tracker/shared';
import { buildRosterModel, confidenceTierFor, toRateValue } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Record } from '@/components/analytics/Record';
import { LIST_INLINE_MAX } from '@/components/analytics/BoundedList';
import { CHART_TOKENS } from '@/components/charts/tokens';
import { DrillableRow, DrillableRowChevron } from '@/components/DrillableRow';
import { useFighterNameResolver } from '@/hooks/useFighterName';
import { useSubjectPath } from '@/hooks/useSubjectPath';
import { getFighterById } from '@/data/sprites';
import { buildDrillDownSearch } from '@/lib/drillDownParams';

const USAGE_BAR_HEIGHT_PX = 10;

interface RosterRowShape {
  fighterId: number;
  games: number;
  /** 0..1, never a percent — the row formats it. */
  share: number;
  wins: number;
  losses: number;
}

function toRowShape(entry: RosterFighterEntry): RosterRowShape {
  return {
    fighterId: entry.fighterId,
    games: entry.games,
    share: entry.share,
    wins: entry.rate.wins,
    losses: entry.rate.losses,
  };
}

/**
 * A plain per-fighter share listing over the whole account, applying NO
 * main/secondary/pocket threshold — used only below `buildRosterModel`'s own
 * establishment floor (`model.main === null`, "main not established yet"),
 * where the grouped anatomy has nothing to group, and to re-derive
 * individual rows for the pooled pockets group's own inline expansion
 * (`RosterPocketGroup` only carries a pooled record, not a per-fighter one).
 * T-39.1-16-01: this is a sort, never a classification — it never compares
 * against `ROSTER_MAIN_MIN_GAMES`/`ROSTER_SECONDARY_MIN_SHARE`/
 * `ROSTER_SECONDARY_MIN_GAMES`, so it cannot re-derive the roster model.
 */
function buildFlatShareList(matches: Match[]): RosterRowShape[] {
  const groups = new Map<number, Match[]>();
  for (const match of matches) {
    const existing = groups.get(match.fighter_id);
    if (existing) {
      existing.push(match);
    } else {
      groups.set(match.fighter_id, [match]);
    }
  }
  const total = matches.length;
  const rows: RosterRowShape[] = [];
  for (const [fighterId, group] of groups) {
    const rate = toRateValue(group);
    rows.push({
      fighterId,
      games: rate.total,
      share: total > 0 ? rate.total / total : 0,
      wins: rate.wins,
      losses: rate.losses,
    });
  }
  return rows.sort((a, b) => b.games - a.games || a.fighterId - b.fighterId);
}

/**
 * One roster row (UI-SPEC §8.4): sprite 24px, the localised fighter name in
 * the row's one flexible truncating slot, the share percentage, a usage bar
 * in ONE identity colour (`--viz-series-1`) on a muted track — nominal
 * categories (which fighter) are never coloured by rank, replacing
 * `RosterUsage.tsx`'s old `--chart-1..5` cycle — a `Record` (which alone
 * carries the games count, UI-SPEC §6.5 rule 4) and the confidence glyph.
 * Wraps in Phase 38's `DrillableRow` (`as="overlay"`, `PairingOpponents.tsx`'s
 * established multi-segment-row pattern) and navigates to Fighter Analysis
 * with the fighter axis.
 */
function RosterRow({
  entry,
  t,
  subjectPath,
  fighterName,
}: {
  entry: RosterRowShape;
  t: TFunction;
  subjectPath: (path: string) => string;
  fighterName: (id: number) => string;
}) {
  const fighter = getFighterById(entry.fighterId);
  const name = fighterName(entry.fighterId);
  const sharePercent = Math.round(entry.share * 100);
  const tier = confidenceTierFor(entry.games);
  const cueLabel = tier ? t(`shared.evidence.sampleCueGlyph.${tier}`, { count: entry.games }) : '';
  const recordText = `${entry.wins}–${entry.losses}`;
  const to = subjectPath(
    `/fighter-analysis?${buildDrillDownSearch({ fighterId: entry.fighterId }).toString()}`,
  );

  return (
    <li
      className="@container/roster-row relative flex items-center gap-3 rounded-md p-2 hover:bg-accent"
      data-slot="roster-row"
    >
      <DrillableRow
        as="overlay"
        to={to}
        ariaLabel={t('shared.drillableRow.aria', { subject: name, context: recordText })}
      />
      {fighter?.url && <img src={fighter.url} alt="" className="size-6 shrink-0 object-contain" />}
      <span className="min-w-0 flex-1 truncate" title={name} data-truncate-guard>
        {name}
      </span>
      <span className="shrink-0 text-sm text-muted-foreground tabular-nums">{sharePercent}%</span>
      <span
        className="w-16 shrink-0 overflow-hidden rounded-full bg-muted @max-[380px]/roster-row:hidden"
        style={{ height: USAGE_BAR_HEIGHT_PX }}
        data-slot="roster-usage-bar-track"
      >
        <span
          className="block h-full rounded-full"
          data-slot="roster-usage-bar-fill"
          style={{ width: `${Math.max(sharePercent, 2)}%`, backgroundColor: CHART_TOKENS.series1 }}
        />
      </span>
      <Record wins={entry.wins} losses={entry.losses} cue="glyph" cueLabel={cueLabel} />
      <DrillableRowChevron />
    </li>
  );
}

function RosterRowList({
  entries,
  t,
  subjectPath,
  fighterName,
}: {
  entries: RosterRowShape[];
  t: TFunction;
  subjectPath: (path: string) => string;
  fighterName: (id: number) => string;
}) {
  return (
    <ul className="flex min-w-0 flex-1 flex-col gap-1">
      {entries.map((entry) => (
        <RosterRow
          key={entry.fighterId}
          entry={entry}
          t={t}
          subjectPath={subjectPath}
          fighterName={fighterName}
        />
      ))}
    </ul>
  );
}

/**
 * One labelled group (UI-SPEC §8.4): the overline label sits in a fixed
 * 112px-equivalent first column at >= 640px, and stacks above its rows below
 * that. A group with no members is never rendered by the caller — this
 * component renders NO header of its own accord; the caller decides whether
 * to mount it at all (T-39.1-16-04: an empty group never implies existence).
 */
function RosterGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-3"
      data-slot="roster-group"
    >
      <div
        className="text-[0.6875rem] leading-4 font-semibold tracking-wider text-muted-foreground uppercase sm:w-28 sm:shrink-0"
        data-slot="roster-group-header"
      >
        {label}
      </div>
      {children}
    </div>
  );
}

/**
 * The Match Data roster card (INS-05/UIX-04, UI-SPEC §8.4, owner note 7):
 * ONE list in three labelled groups — MAIN, SECONDARIES, POCKETS — derived
 * from `buildRosterModel`, the shared engine's single definition
 * (T-39.1-16-01: this component reads it, it never re-derives a threshold).
 * The pockets group collapses to one pooled summary row with an inline
 * "show all" expansion (capped at `LIST_INLINE_MAX`). Below the model's
 * establishment floor the card falls back to `mainNotEstablished` plus a
 * flat, ungrouped share list.
 */
export function RosterUsage({ matches }: { matches: Match[] }) {
  const { t } = useTranslation();
  const subjectPath = useSubjectPath();
  const fighterName = useFighterNameResolver();
  const [pocketsExpanded, setPocketsExpanded] = useState(false);

  const model = useMemo(() => buildRosterModel({ matches }), [matches]);
  const flatEntries = useMemo(() => buildFlatShareList(matches), [matches]);
  const flatByFighterId = useMemo(
    () => new Map(flatEntries.map((entry) => [entry.fighterId, entry])),
    [flatEntries],
  );
  const pocketEntries = useMemo(
    () =>
      model.pockets.fighterIds
        .map((id) => flatByFighterId.get(id))
        .filter((entry): entry is RosterRowShape => entry != null)
        .sort((a, b) => b.games - a.games || a.fighterId - b.fighterId),
    [model.pockets.fighterIds, flatByFighterId],
  );

  if (matches.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('matchData.roster.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{t('common.noMatchData')}</p>
        </CardContent>
      </Card>
    );
  }

  if (model.main === null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('matchData.roster.title')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            {t('analytics.roster.mainNotEstablished')}
          </p>
          <RosterRowList
            entries={flatEntries}
            t={t}
            subjectPath={subjectPath}
            fighterName={fighterName}
          />
        </CardContent>
      </Card>
    );
  }

  const mainEntry = toRowShape(model.main);
  const secondaryEntries = model.secondaries.map(toRowShape);
  const pocketRatePercent = Math.round(model.pockets.rate.rate * 100);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('matchData.roster.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <RosterGroup label={t('analytics.roster.main')}>
          <RosterRowList
            entries={[mainEntry]}
            t={t}
            subjectPath={subjectPath}
            fighterName={fighterName}
          />
        </RosterGroup>

        {secondaryEntries.length > 0 && (
          <RosterGroup label={t('analytics.roster.secondaries')}>
            <RosterRowList
              entries={secondaryEntries}
              t={t}
              subjectPath={subjectPath}
              fighterName={fighterName}
            />
          </RosterGroup>
        )}

        {model.pockets.fighterIds.length > 0 && (
          <RosterGroup label={t('analytics.roster.pockets')}>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <ul className="flex flex-col gap-1">
                <li
                  className="flex flex-col gap-1 rounded-md p-2 text-sm text-muted-foreground"
                  data-slot="roster-pocket-summary"
                >
                  <span>
                    {t('analytics.roster.pocketsRow', {
                      count: model.pockets.fighterIds.length,
                      games: model.pockets.games,
                    })}
                    {' · '}
                    {pocketRatePercent}%
                  </span>
                </li>
              </ul>
              {!pocketsExpanded ? (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="w-fit self-start px-0"
                  onClick={() => setPocketsExpanded(true)}
                >
                  {t('analytics.list.showAll', { count: model.pockets.fighterIds.length })}
                </Button>
              ) : (
                <>
                  <RosterRowList
                    entries={pocketEntries.slice(0, LIST_INLINE_MAX)}
                    t={t}
                    subjectPath={subjectPath}
                    fighterName={fighterName}
                  />
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="w-fit self-start px-0"
                    onClick={() => setPocketsExpanded(false)}
                  >
                    {t('analytics.list.showFewer')}
                  </Button>
                </>
              )}
            </div>
          </RosterGroup>
        )}
      </CardContent>
    </Card>
  );
}
