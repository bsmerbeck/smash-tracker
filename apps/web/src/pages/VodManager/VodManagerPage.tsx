import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { Match } from '@smash-tracker/shared';
import { getFighterById } from '@/data/sprites';
import { useFilteredMatches } from '@/hooks/useFilteredMatches';
import { tournamentLabel } from '@/pages/MatchData/lib/matchTableFilters';
import {
  DEFAULT_VOD_MANAGER_FILTERS,
  applyVodManagerFilters,
  getVodManagerFilterOptions,
  sortByRecency,
  type VodManagerFilterState,
  type VodSortDirection,
} from './lib/vodManagerFilters';
import { VodMatchList } from './components/VodMatchList';
import { VodPlayer } from './components/VodPlayer';
import { TimestampList } from './components/TimestampList';

/**
 * `/vod` — the VOD Manager: a master-detail page listing every match with a
 * VOD attached (LIB-01), filterable/sortable (LIB-02) in the left panel,
 * with the right panel showing the embedded, seekable player (PLAY-01/02),
 * the click-to-seek timestamp list directly below it (PLAY-03, D-03), and
 * the selected match's read-only metadata.
 *
 * Selection is URL-driven (`?match=<id>`, `useSearchParams` — the single
 * source of truth per ARCHITECTURE.md): selecting a list row updates the
 * URL, and `/vod?match=<id>` deep-links directly into that match. On
 * cold-open (no `?match=` yet, D-04) the most-recent VOD match is
 * auto-selected via a replace navigation so the panel is never empty on
 * entry with at least one VOD-having match.
 */
export function VodManagerPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedMatchId = searchParams.get('match');

  const { matches, isLoading } = useFilteredMatches();
  const vodMatches = useMemo(() => matches.filter((m) => m.vodUrl != null), [matches]);

  const [filters, setFilters] = useState<VodManagerFilterState>(DEFAULT_VOD_MANAGER_FILTERS);
  const [sort, setSort] = useState<VodSortDirection>('newest');
  const [selectedTimestampIndex, setSelectedTimestampIndex] = useState<number | null>(null);

  // A new match starts with no timestamp note selected — the highlight is
  // fixed to the last click (D-13/D-14), not carried over between matches.
  // React's "adjusting state when a prop changes" pattern (reset during
  // render, not an effect) so switching matches never flashes a stale
  // selection from the previous match before an effect gets a chance to run.
  const [trackedMatchId, setTrackedMatchId] = useState(selectedMatchId);
  if (selectedMatchId !== trackedMatchId) {
    setTrackedMatchId(selectedMatchId);
    setSelectedTimestampIndex(null);
  }

  const filterOptions = useMemo(() => getVodManagerFilterOptions(vodMatches), [vodMatches]);
  const filtered = useMemo(() => {
    return sortByRecency(applyVodManagerFilters(vodMatches, filters), sort);
  }, [vodMatches, filters, sort]);

  // D-04 cold-open: once loaded, with nothing deep-linked/clicked yet and at
  // least one VOD match available, auto-select the most-recent one via a
  // replace navigation so the back button doesn't get stuck on an empty
  // intermediate URL.
  useEffect(() => {
    if (isLoading || selectedMatchId != null || filtered.length === 0) {
      return;
    }
    setSearchParams({ match: filtered[0]!.id }, { replace: true });
  }, [isLoading, selectedMatchId, filtered, setSearchParams]);

  // T-01-04: an unknown/stale ?match= id resolves to null rather than
  // throwing — the right panel just falls back to the placeholder copy.
  const selectedMatch = filtered.find((m) => m.id === selectedMatchId) ?? null;

  // Populated by VodPlayer once its live player instance exists; invoking
  // it is how TimestampList's row clicks reach the LIVE player (not a URL
  // reload — PITFALLS.md Pitfall 1).
  const playerSeekRef = useRef<((seconds: number) => void) | null>(null);

  function handleSelect(id: string) {
    setSearchParams({ match: id });
  }

  function handleSeek(seconds: number) {
    playerSeekRef.current?.(seconds);
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t('vodManager.title')}</h1>

      {!isLoading && vodMatches.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('vodManager.emptyState')}</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-[360px_1fr]">
          <VodMatchList
            matches={filtered}
            filters={filters}
            filterOptions={filterOptions}
            onFiltersChange={setFilters}
            sort={sort}
            onSortChange={setSort}
            selectedId={selectedMatchId}
            onSelect={handleSelect}
          />

          <div className="flex flex-col gap-4">
            {selectedMatch?.vodUrl != null ? (
              <>
                <VodPlayer vodUrl={selectedMatch.vodUrl} startSeconds={0} seekRef={playerSeekRef} />
                <TimestampList
                  timestamps={selectedMatch.vodTimestamps ?? []}
                  selectedIndex={selectedTimestampIndex}
                  onSelect={setSelectedTimestampIndex}
                  onSeek={handleSeek}
                />
              </>
            ) : (
              <div className="aspect-video rounded-lg border bg-muted flex items-center justify-center text-sm text-muted-foreground">
                {t('vodManager.playerPlaceholder')}
              </div>
            )}

            {selectedMatch && <SelectedMatchMeta match={selectedMatch} />}
          </div>
        </div>
      )}
    </div>
  );
}

function SelectedMatchMeta({ match }: { match: Match }) {
  const { t } = useTranslation();
  const fighter = getFighterById(match.fighter_id);
  const opponentFighter = getFighterById(match.opponent_id);

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-4 text-sm">
      <h2 className="text-xl font-semibold tracking-tight">
        vs. {match.opponent || t('common.unknown')}
      </h2>
      <dl className="grid grid-cols-2 gap-2 text-muted-foreground">
        <div>
          <dt className="text-xs">{t('vodManager.filters.fighter')}</dt>
          <dd className="text-foreground">{fighter?.name ?? t('common.unknown')}</dd>
        </div>
        <div>
          <dt className="text-xs">{t('vodManager.filters.opponentFighter')}</dt>
          <dd className="text-foreground">{opponentFighter?.name ?? t('common.unknown')}</dd>
        </div>
        <div>
          <dt className="text-xs">{t('vodManager.filters.stage')}</dt>
          <dd className="text-foreground">{match.map?.name ?? t('common.unknown')}</dd>
        </div>
        <div>
          <dt className="text-xs">{t('vodManager.filters.tournament')}</dt>
          <dd className="text-foreground">{tournamentLabel(match)}</dd>
        </div>
        <div>
          <dt className="text-xs">{t('matchData.table.columns.win')}</dt>
          <dd className="text-foreground">{match.win ? t('common.win') : t('common.loss')}</dd>
        </div>
      </dl>
    </div>
  );
}
