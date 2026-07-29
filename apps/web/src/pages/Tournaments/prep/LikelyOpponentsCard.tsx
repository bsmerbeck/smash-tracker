import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import {
  PREP_LIKELY_OPPONENTS_MAX,
  type Match,
  type OpponentNote,
  type PrepPresenceMap,
} from '@smash-tracker/shared';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { getFighterById } from '@/data/sprites';
import { useFighterNameResolver } from '@/hooks/useFighterName';
import { getOpponentProfile } from '@/lib/stats';
import { useAddLikelyOpponent, useRemoveLikelyOpponent } from '@/hooks/usePrepBrief';
import {
  rankLikelyOpponentSuggestions,
  type LikelyOpponentSuggestion,
} from './likelyOpponentSuggestions';
import { OpponentNoteReadout } from './OpponentNoteReadout';

export interface LikelyOpponentsCardProps {
  entryKey: string;
  /** Presence map of curated likely-opponent canonical names (D-19). */
  likelyOpponents: PrepPresenceMap;
  /**
   * All-time, alias-resolved matches — supplied by the page. NOT the
   * Dashboard's globally-filtered match set; a filter left active on an
   * unrelated page must never shrink this brief's head-to-head history.
   */
  matches: Match[];
  /** Every canonical opponent name known to the user, for the add-picker's full universe. */
  canonicalOpponents: string[];
  /** Canonical opponent name -> stored scouting note. */
  notes: Record<string, OpponentNote>;
}

/**
 * Every number rendered on this card comes from `matches` and `notes`, both
 * of which the page supplies from stored data — nothing here may be
 * inferred, generated, or defaulted. An opponent with no history gets an
 * honest empty line (PREP-02).
 */
export function LikelyOpponentsCard({
  entryKey,
  likelyOpponents,
  matches,
  canonicalOpponents,
  notes,
}: LikelyOpponentsCardProps) {
  const { t } = useTranslation();
  const resolveFighterName = useFighterNameResolver();
  const addOpponent = useAddLikelyOpponent(entryKey);
  const removeOpponent = useRemoveLikelyOpponent(entryKey);
  const [open, setOpen] = useState(false);

  const curatedNames = useMemo(
    () => Object.keys(likelyOpponents).sort((a, b) => a.localeCompare(b)),
    [likelyOpponents],
  );
  const atLimit = curatedNames.length >= PREP_LIKELY_OPPONENTS_MAX;

  const suggestionsByOpponent = useMemo(() => {
    const suggestions = rankLikelyOpponentSuggestions(matches);
    return new Map(suggestions.map((suggestion) => [suggestion.opponent, suggestion]));
  }, [matches]);

  // The full canonical universe, ordered by the same deterministic rule as
  // `rankLikelyOpponentSuggestions` (90-day count DESC, last-played DESC,
  // name ASC) — a canonical opponent with zero recorded matches still
  // appears, just at the tail of the order, since a zeroed suggestion never
  // outranks one with real match history.
  const pickerCandidates: LikelyOpponentSuggestion[] = useMemo(() => {
    return canonicalOpponents
      .filter((name) => !likelyOpponents[name])
      .map(
        (name) =>
          suggestionsByOpponent.get(name) ?? {
            opponent: name,
            last90DayCount: 0,
            lastPlayedAt: 0,
            totalCount: 0,
          },
      )
      .sort(
        (a, b) =>
          b.last90DayCount - a.last90DayCount ||
          b.lastPlayedAt - a.lastPlayedAt ||
          a.opponent.localeCompare(b.opponent),
      );
  }, [canonicalOpponents, likelyOpponents, suggestionsByOpponent]);

  function handleAdd(name: string) {
    addOpponent.mutate(name);
    setOpen(false);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('prep.opponents.title')}</CardTitle>
        <CardAction>
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button type="button" variant="outline" size="sm" disabled={atLimit}>
                {t('prep.opponents.add')}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-64 p-0">
              <Command>
                <CommandInput placeholder={t('prep.opponents.addPlaceholder')} />
                <CommandList>
                  <CommandEmpty>{t('prep.opponents.addEmpty')}</CommandEmpty>
                  <CommandGroup>
                    {pickerCandidates.map((candidate) => (
                      <CommandItem
                        key={candidate.opponent}
                        value={candidate.opponent}
                        onSelect={() => handleAdd(candidate.opponent)}
                      >
                        <span className="flex w-full items-center justify-between gap-2">
                          <span>{candidate.opponent}</span>
                          <span className="text-xs text-muted-foreground">
                            {t('prep.opponents.matchCount', { count: candidate.totalCount })}
                          </span>
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {atLimit && (
          <p className="text-xs text-muted-foreground">
            {t('prep.opponents.limitReached', { count: PREP_LIKELY_OPPONENTS_MAX })}
          </p>
        )}
        {curatedNames.length === 0 ? (
          <div className="flex flex-col items-center gap-1 py-6 text-center">
            <h3 className="text-sm font-medium">{t('prep.opponents.empty.title')}</h3>
            <p className="text-sm text-muted-foreground">{t('prep.opponents.empty.body')}</p>
          </div>
        ) : (
          curatedNames.map((name) => {
            const profile = getOpponentProfile(matches, name);
            const characters = profile?.byTheirFighter ?? [];
            return (
              <div key={name} className="flex flex-col gap-2 rounded-md border p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{name}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground"
                    aria-label={t('prep.opponents.remove', { name })}
                    onClick={() => removeOpponent.mutate(name)}
                  >
                    <X />
                  </Button>
                </div>

                <p className="text-sm text-muted-foreground">
                  {profile
                    ? t('prep.opponents.record', {
                        wins: profile.record.wins,
                        losses: profile.record.losses,
                        ratio: profile.record.winRate,
                        totalMatches: profile.record.total,
                      })
                    : t('prep.opponents.noRecord', { name })}
                </p>

                {characters.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {t('prep.opponents.noCharacters')}
                  </p>
                ) : (
                  <ul className="flex flex-wrap gap-2">
                    {characters.map((entry) => {
                      const sprite = getFighterById(entry.opponentFighterId);
                      return (
                        <li key={entry.opponentFighterId} className="flex items-center gap-2">
                          {sprite && (
                            <img src={sprite.url} alt="" className="size-10 object-contain" />
                          )}
                          <span className="text-sm">
                            {resolveFighterName(entry.opponentFighterId)}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}

                <OpponentNoteReadout note={notes[name]} />
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
