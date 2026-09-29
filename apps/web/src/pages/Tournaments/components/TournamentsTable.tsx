import { useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ExternalLink } from 'lucide-react';
import {
  confidenceTierFor,
  type TierResolution,
  type TournamentEntry,
} from '@smash-tracker/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { DrillableRow, DrillableRowChevron } from '@/components/DrillableRow';
import { LIST_PASS_MAX, LIST_PASS_STEP } from '@/components/analytics/BoundedList';
import { INLINE_LINK_TONE, MUTED_LINK_TONE } from '@/components/analytics/linkTone';
import { Record } from '@/components/analytics/Record';
import { SeedDelta } from '@/components/analytics/tier/SeedDelta';
import { TierBadge } from '@/components/analytics/tier/TierBadge';
import { TierProvenanceLine } from '@/components/analytics/tier/TierProvenanceLine';
import { useTierProvenanceText } from '@/components/analytics/tier/tierProvenance';
import { useRowLayout, type RowLayout } from '@/hooks/useRowLayout';
import { entryDisplayDateRange, isAdminImportedEntry } from '@/lib/historicalTournament';
import type { WinLossRecord } from '@/lib/stats';
import { cn } from '@/lib/utils';
import { buildStartggUrl } from '@/pages/Tournaments/lib/startggLinks';

/** One table row: a registry entry, its win/loss record, and its once-resolved tier. */
export interface TournamentTableRow {
  entry: TournamentEntry;
  record: WinLossRecord;
  resolution: TierResolution;
}

/** The narrow (stacked, below 640px) layout pages in 20s — its own pair, not a `BoundedList` constant. */
export const TOURNAMENTS_STACK_PASS_MAX = 20;
export const TOURNAMENTS_STACK_PASS_STEP = 20;

const MISSING = '—';
const EN_DASH = '–';
const COLUMN_COUNT = 6;

/** The `overline` role (UI-SPEC §5). */
const OVERLINE =
  'text-[0.6875rem] leading-4 font-semibold tracking-wider text-muted-foreground uppercase';

function entryKeyOf(entry: TournamentEntry): string {
  return entry.entryKey ?? String(entry.eventId ?? entry.eventName);
}

function formatDate(time: number, locale: string): string {
  return new Date(time).toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Phase 30.3 (Gate 4): dates render from `entryDisplayDateRange` — imported
 * rows prefer the public data's own event dates, and an entry with nothing
 * recorded renders the '—' missing marker rather than an epoch-zero date.
 */
function formatDateRange(entry: TournamentEntry, locale: string): string {
  const range = entryDisplayDateRange(entry);
  if (range == null) {
    return MISSING;
  }
  const start = formatDate(range.startMs, locale);
  const end = formatDate(range.endMs, locale);
  return start === end ? start : `${start} ${EN_DASH} ${end}`;
}

interface YearGroup {
  /** `null` is the trailing "No date" group. */
  year: number | null;
  rows: TournamentTableRow[];
}

/**
 * One group per calendar year of the row's display END date (newest first,
 * matching the date the Date column shows), undated rows last. Within a year
 * rows keep the newest-first order of the registry.
 */
function groupRowsByYear(rows: TournamentTableRow[]): YearGroup[] {
  const dated = new Map<number, TournamentTableRow[]>();
  const undated: TournamentTableRow[] = [];
  const endOf = (row: TournamentTableRow) => entryDisplayDateRange(row.entry)?.endMs ?? 0;
  const ordered = [...rows].sort(
    (a, b) => endOf(b) - endOf(a) || b.entry.lastSetAt - a.entry.lastSetAt,
  );
  for (const row of ordered) {
    const range = entryDisplayDateRange(row.entry);
    if (range == null) {
      undated.push(row);
      continue;
    }
    const year = new Date(range.endMs).getFullYear();
    const bucket = dated.get(year);
    if (bucket) {
      bucket.push(row);
    } else {
      dated.set(year, [row]);
    }
  }
  const groups: YearGroup[] = [...dated.entries()]
    .sort(([a], [b]) => b - a)
    .map(([year, groupRows]) => ({ year, rows: groupRows }));
  if (undated.length > 0) {
    groups.push({ year: null, rows: undated });
  }
  return groups;
}

/** The tier badge, the setting / kind badges (DD-03) and the provenance line, on two lines. */
function TierCell({ resolution }: { resolution: TierResolution }) {
  const { t } = useTranslation();
  const provenance = useTierProvenanceText(resolution) ?? '';
  return (
    <div data-slot="tier-cell" className="flex min-w-0 flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <TierBadge
          tier={resolution.tier}
          basis={resolution.basis}
          source={resolution.source}
          provenance={provenance}
        />
        {resolution.setting === 'online' && (
          <Badge variant="outline">{t('tiers.setting.online')}</Badge>
        )}
        {resolution.eventKind === 'side-event' && (
          <Badge variant="outline">{t('tiers.kind.sideEvent')}</Badge>
        )}
      </div>
      <TierProvenanceLine resolution={resolution} />
    </div>
  );
}

/** Everything a row prints, derived once so the table and the stacked row can never disagree. */
function useRowFacts(row: TournamentTableRow, locale: string) {
  const { t } = useTranslation();
  const { entry, record, resolution } = row;
  const numbers = new Intl.NumberFormat(locale);
  const ordinal =
    entry.placement != null
      ? t('tournaments.table.placement', { count: entry.placement, ordinal: true })
      : null;
  const placementText =
    ordinal == null
      ? MISSING
      : entry.numEntrants != null
        ? t('tournaments.table.placementOf', {
            placement: ordinal,
            entrants: numbers.format(entry.numEntrants),
          })
        : ordinal;
  // Phase 30.3 (Gate 4): an imported snapshot with no locally linked match
  // rows has NO observed games — a 0-0 record would fabricate a zero out of
  // missing data, so the record renders the '—' missing marker instead.
  const recordUnknown = isAdminImportedEntry(entry) && record.total === 0;
  const recordText = recordUnknown
    ? MISSING
    : `${numbers.format(record.wins)}${EN_DASH}${numbers.format(record.losses)}`;
  const confidence = confidenceTierFor(record.total);
  const cueLabel = confidence
    ? t(`shared.evidence.sampleCueGlyph.${confidence}`, { count: record.total })
    : '';
  const tournament = entry.tournamentName ?? entry.eventName;
  const date = formatDateRange(entry, locale);
  const rowAria = t('tournaments.table.rowAria', {
    tournament,
    event: entry.eventName,
    date,
    tier: t(`tiers.label.${resolution.tier}`),
    placement: placementText,
    record: recordText,
  });
  return {
    tournament,
    date,
    placementText,
    recordUnknown,
    cueLabel,
    rowAria,
    destination: `/tournaments/${entryKeyOf(entry)}`,
    startggUrl: buildStartggUrl(entry.slug),
  };
}

function RecordCell({
  row,
  facts,
  locale,
  wrap = false,
}: {
  row: TournamentTableRow;
  facts: ReturnType<typeof useRowFacts>;
  locale: string;
  wrap?: boolean;
}) {
  if (facts.recordUnknown) {
    return <span className="text-muted-foreground">{MISSING}</span>;
  }
  return (
    <Record
      wins={row.record.wins}
      losses={row.record.losses}
      cue="glyph"
      cueLabel={facts.cueLabel}
      locale={locale}
      wrap={wrap}
    />
  );
}

function ExternalStartggLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      aria-label={label}
      className="relative inline-flex shrink-0 text-muted-foreground hover:text-foreground"
    >
      <ExternalLink className="size-3.5" />
    </a>
  );
}

function TableRowView({ row, locale }: { row: TournamentTableRow; locale: string }) {
  const { t } = useTranslation();
  const facts = useRowFacts(row, locale);
  const { entry } = row;
  return (
    <TableRow data-slot="tournaments-row" className="relative hover:bg-accent">
      <TableCell className="w-44 min-w-44 max-w-44 py-2 align-top whitespace-normal">
        <DrillableRow to={facts.destination} as="overlay" ariaLabel={facts.rowAria} />
        <TierCell resolution={row.resolution} />
      </TableCell>
      <TableCell className="w-full max-w-0 py-2 align-top">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <Link
              to={facts.destination}
              title={facts.tournament}
              className={cn('relative min-w-0 truncate font-medium', INLINE_LINK_TONE)}
            >
              {facts.tournament}
            </Link>
            {facts.startggUrl && (
              <ExternalStartggLink href={facts.startggUrl} label={t('shared.startgg.view')} />
            )}
          </span>
          <span
            title={entry.eventName}
            className="min-w-0 truncate text-xs leading-4 text-muted-foreground"
          >
            {entry.eventName}
          </span>
        </div>
      </TableCell>
      <TableCell className="min-w-30 py-2 align-top tabular-nums">{facts.date}</TableCell>
      <TableCell data-col="place" className="min-w-28 py-2 align-top text-xs tabular-nums">
        {facts.placementText}
      </TableCell>
      <TableCell className="min-w-20 py-2 align-top text-xs">
        <SeedDelta seed={entry.seed} placement={entry.placement} locale={locale} />
      </TableCell>
      <TableCell className="min-w-52 py-2 align-top">
        <span className="flex items-center justify-between gap-2">
          <RecordCell row={row} facts={facts} locale={locale} />
          <DrillableRowChevron />
        </span>
      </TableCell>
    </TableRow>
  );
}

function StackRowView({ row, locale }: { row: TournamentTableRow; locale: string }) {
  const { t } = useTranslation();
  const facts = useRowFacts(row, locale);
  const { entry } = row;
  return (
    <li
      data-slot="tournaments-row"
      className="relative flex min-w-0 flex-col gap-1 rounded-md px-2 py-2 hover:bg-accent"
    >
      <DrillableRow to={facts.destination} as="overlay" ariaLabel={facts.rowAria} />
      <div className="flex min-w-0 items-center gap-2">
        <Link
          to={facts.destination}
          title={facts.tournament}
          className={cn('relative min-w-0 flex-1 truncate text-sm font-medium', INLINE_LINK_TONE)}
        >
          {facts.tournament}
        </Link>
        {facts.startggUrl && (
          <ExternalStartggLink href={facts.startggUrl} label={t('shared.startgg.view')} />
        )}
        <span className="shrink-0 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
          {facts.date}
        </span>
        <DrillableRowChevron />
      </div>
      <TierCell resolution={row.resolution} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm tabular-nums">
        <span className="whitespace-nowrap">{facts.placementText}</span>
        <SeedDelta seed={entry.seed} placement={entry.placement} locale={locale} />
        <RecordCell row={row} facts={facts} locale={locale} wrap />
      </div>
    </li>
  );
}

export interface TournamentsTableProps {
  rows: TournamentTableRow[];
  /** Forces one layout (tests / hosts); otherwise read once from the viewport (below 640px: stacked rows). */
  layout?: RowLayout;
}

/**
 * The Tournaments table (TIER-02 / T-08, UI-SPEC §7.11): Tier, Event, Date,
 * Placement, Seed Δ, Record, grouped under year headers newest first. Every
 * row is a `DrillableRow` overlay into the event, the Event cell is the row's
 * one flexible truncating slot, and the list mounts at most 100 rows (20 on a
 * phone) per pass with an explicit "Show more" — never an inner scroller.
 * Below 640px the same rows stack; exactly one layout root mounts.
 *
 * Callers `key` this component on the active filters so paging progress
 * resets when the row set changes.
 */
export function TournamentsTable({ rows, layout: layoutOverride }: TournamentsTableProps) {
  const { t, i18n } = useTranslation();
  const layout = useRowLayout(layoutOverride);
  const cap = layout === 'stack' ? TOURNAMENTS_STACK_PASS_MAX : LIST_PASS_MAX;
  const step = layout === 'stack' ? TOURNAMENTS_STACK_PASS_STEP : LIST_PASS_STEP;
  const [requested, setRequested] = useState(0);
  const visibleCount = Math.min(rows.length, Math.max(cap, requested));

  const groups = groupRowsByYear(rows);
  let remainingToMount = visibleCount;
  const mountedGroups: YearGroup[] = [];
  for (const group of groups) {
    if (remainingToMount <= 0) {
      break;
    }
    const mounted = group.rows.slice(0, remainingToMount);
    remainingToMount -= mounted.length;
    mountedGroups.push({ year: group.year, rows: mounted });
  }
  const remaining = rows.length - visibleCount;
  const nextStep = Math.min(step, remaining);

  const headerLabel = (group: YearGroup, total: number) =>
    group.year == null
      ? t('tournaments.table.undated')
      : t('tournaments.table.yearGroup', { year: group.year, count: total });
  const totalFor = (group: YearGroup) =>
    groups.find((candidate) => candidate.year === group.year)?.rows.length ?? group.rows.length;

  const pagingButton =
    remaining > 0 ? (
      <Button
        type="button"
        variant="link"
        size="sm"
        className={MUTED_LINK_TONE}
        onClick={() => setRequested(visibleCount + nextStep)}
      >
        {t(layout === 'stack' ? 'tournaments.table.showMore20' : 'tournaments.table.showMore50')}
      </Button>
    ) : null;

  if (layout === 'stack') {
    return (
      <div className="flex flex-col gap-2">
        <ul data-slot="tournaments-table" className="flex flex-col divide-y">
          {mountedGroups.map((group) => (
            <li key={group.year ?? 'undated'} className="list-none">
              <p className={cn('px-2 py-2', OVERLINE)}>{headerLabel(group, totalFor(group))}</p>
              <ul className="flex flex-col divide-y">
                {group.rows.map((row) => (
                  <StackRowView key={entryKeyOf(row.entry)} row={row} locale={i18n.language} />
                ))}
              </ul>
            </li>
          ))}
        </ul>
        {pagingButton}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Table data-slot="tournaments-table">
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{t('tournaments.table.tier')}</TableHead>
            <TableHead scope="col">{t('tournaments.table.event')}</TableHead>
            <TableHead scope="col">{t('tournaments.table.date')}</TableHead>
            <TableHead scope="col">{t('tournaments.table.placement')}</TableHead>
            <TableHead scope="col">{t('tournaments.table.seedDelta')}</TableHead>
            <TableHead scope="col">{t('tournaments.table.record')}</TableHead>
          </TableRow>
        </TableHeader>
        {mountedGroups.map((group) => (
          <TableBody key={group.year ?? 'undated'} data-slot="tournaments-year-group">
            <TableRow className="h-8 hover:bg-transparent">
              <th
                colSpan={COLUMN_COUNT}
                scope="colgroup"
                className={cn('h-8 px-2 text-left align-middle', OVERLINE)}
              >
                {headerLabel(group, totalFor(group))}
              </th>
            </TableRow>
            {group.rows.map((row) => (
              <TableRowView key={entryKeyOf(row.entry)} row={row} locale={i18n.language} />
            ))}
          </TableBody>
        ))}
      </Table>
      {pagingButton}
    </div>
  );
}
