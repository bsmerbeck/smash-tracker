import { useMemo, useState, type ReactNode } from 'react';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Check, ChevronsUpDown, X } from 'lucide-react';
import type { CreateMatchInput, Fighter } from '@smash-tracker/shared';
import { matchTypeValues, TOURNAMENT_LEGAL_STAGE_IDS } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Input } from '@/components/ui/input';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { localizedFighterName } from '@/lib/fighterNames';
import { StageSelectGroups, StageSelectValue } from '@/components/StageSelectGroups';
import { NO_SELECTION_STAGE } from '@/data/stages';
import { useOpponents } from '@/hooks/useOpponents';
import { useMatches } from '@/hooks/useMatches';
import { useStageFavorites, useToggleStageFavorite } from '@/hooks/useStageFavorites';
import { useAlphaFighters } from '@/hooks/useFighterName';
import { getGroupedStageOptions, stageOptions } from '@/lib/stageOptions';
import { TournamentFields, matchTypeLabel } from './MatchForm';
import { isFormatSelectable } from './continueSetLogic';
import {
  setFormatValues,
  winsNeededFor,
  maxGamesFor,
  getSetScore,
  isSetDecided,
  shouldShowGame,
  formatSetScore,
  buildContinuationPayloads,
  buildDefaultGameValues,
  resolveSetFighterSelections,
  type SetFormat,
  type SetGameValues,
  type SetSharedValues,
} from './setWizardLogic';

/**
 * Validation for the fields entered once per set (fighter, opponent, match
 * type, tournament). A factory for the same reason as
 * `buildMatchFormSchema`: messages come out of the active locale.
 */
export function buildSetSharedFormSchema(t: TFunction) {
  return z.object({
    fighterId: z
      .number()
      .int()
      .positive({ message: t('matchForm.validation.chooseFighter') }),
    opponentFighterId: z
      .number()
      .int()
      .positive({ message: t('matchForm.validation.chooseOpponentFighter') }),
    opponentName: z.string().min(1, t('matchForm.validation.opponentRequired')),
    matchType: z.enum(matchTypeValues),
    format: z.enum(setFormatValues),
    eventName: z
      .string()
      .max(80, t('matchForm.validation.charLimit', { max: 80 }))
      .optional(),
    tournamentName: z
      .string()
      .max(80, t('matchForm.validation.charLimit', { max: 80 }))
      .optional(),
  });
}
export type SetSharedFormValues = z.infer<ReturnType<typeof buildSetSharedFormSchema>>;

export function useSetSharedForm(
  defaultValues: SetSharedFormValues,
): UseFormReturn<SetSharedFormValues> {
  const { t } = useTranslation();
  return useForm<SetSharedFormValues>({
    resolver: zodResolver(buildSetSharedFormSchema(t)),
    defaultValues,
  });
}

export function defaultSetSharedValues(
  fighterId: number,
  opponentFighterId: number,
): SetSharedFormValues {
  return {
    fighterId,
    opponentFighterId,
    // Same default as the single-game form (see AddMatchForm's
    // buildDefaultValues): untouched entries land on the shared "unknown"
    // opponent instead of demanding a name for random quickplay sets.
    opponentName: 'unknown',
    matchType: 'none',
    format: 'bo3',
    eventName: '',
    tournamentName: '',
  };
}

/** Game numbers to render: 1..maxGames while each game is still reachable under `format` given the results entered so far. Cheap enough (≤5 iterations) to recompute per render. */
function getVisibleGameNumbers(
  format: SetFormat,
  games: SetGameValues[],
  maxGames: number,
): number[] {
  const numbers: number[] = [];
  for (let n = 1; n <= maxGames; n += 1) {
    if (shouldShowGame(format, n, games)) {
      numbers.push(n);
    } else {
      break;
    }
  }
  return numbers;
}

function sharedFormToSetShared(values: SetSharedFormValues): SetSharedValues {
  return {
    fighterId: values.fighterId,
    opponentFighterId: values.opponentFighterId,
    opponentName: values.opponentName.toLowerCase(),
    matchType: values.matchType,
    eventName: values.eventName?.trim() || undefined,
    tournamentName: values.tournamentName?.trim() || undefined,
  };
}

/**
 * The Add Match dialog's "Set (Bo3/Bo5)" mode: shared fields (your fighter,
 * opponent fighter + name, match type, tournament) entered once, followed
 * by per-game rows (stage + result + optional stocks) that appear
 * progressively as the set remains undecided. Submitting builds one
 * `CreateMatchInput` per game via `buildSetGamePayloads` and hands them to
 * the caller's `onSubmitGames`, which is responsible for actually creating
 * them (sequentially, via the existing create-match mutation) and reporting
 * success/partial failure — this component only assembles payloads and
 * renders the wizard UI.
 */
export function SetWizard({
  fighterSprites,
  form,
  games,
  onGamesChange,
  onSubmit,
  footer,
  lockedGames,
  onDropLockedGame,
  onClearLockedGames,
}: {
  /** The fighters offered for "Your Fighter" — the signed-in user's primary+secondary selections. */
  fighterSprites: Fighter[];
  form: UseFormReturn<SetSharedFormValues>;
  games: SetGameValues[];
  onGamesChange: (games: SetGameValues[]) => void;
  onSubmit: (payloads: CreateMatchInput[]) => void | Promise<void>;
  /** Rendered inside the wizard's own `<form>` (e.g. Cancel/Save buttons) so a submit button here triggers `onSubmit` via normal form submission. */
  footer?: ReactNode;
  /**
   * Continue Set mode: games already persisted for this set, rendered as
   * read-only leading rows. Numbering, the score chip, `shouldShowGame` and
   * the fighter forward-carry all read `[...lockedGames, ...games]`, so a
   * continuation's next game inherits the last locked game's characters
   * exactly as it would inside one sitting. Omitting this prop (AddMatchForm)
   * degenerates to today's behavior byte-for-byte.
   */
  lockedGames?: SetGameValues[];
  /** Drops one locked game from the LOCAL continuation context — never touches stored data. `index` is 0-based into `lockedGames`. */
  onDropLockedGame?: (index: number) => void;
  /** Drops every locked game from the LOCAL continuation context at once — never touches stored data. */
  onClearLockedGames?: () => void;
}) {
  const { t } = useTranslation();
  const { data: opponents = [] } = useOpponents();
  const { data: allMatches = [] } = useMatches();
  const alphaFighters = useAlphaFighters();
  const [opponentPopoverOpen, setOpponentPopoverOpen] = useState(false);

  const locked = lockedGames ?? [];
  // Plain per-render computation, not useMemo — a fresh array every render
  // regardless (see the `resolvedGamePadded` rationale below), so memoizing
  // on it would be pointless. Passing no `lockedGames` (AddMatchForm) makes
  // this identical in content to `games`.
  const allGames = [...locked, ...games];

  const format = form.watch('format');
  // Read live (not via the games array) so game 1's per-game defaults
  // re-render the instant the set-level pickers change.
  const sharedFighterId = form.watch('fighterId');
  const sharedOpponentFighterId = form.watch('opponentFighterId');
  const score = getSetScore(allGames);
  const decided = isSetDecided(format, score);
  const needed = winsNeededFor(format);
  const maxGames = maxGamesFor(format);

  const visibleGameNumbers = getVisibleGameNumbers(format, allGames, maxGames);
  // No editable row is visible when every visible game number is a locked
  // one — the set is decided by already-saved games alone.
  const noEditableRowVisible = visibleGameNumbers.length <= locked.length;

  // Per-game resolved character pair (SETFEAT-03), one entry per visible
  // game — padded so every visible row has an entry even before it has any
  // values of its own (see `resolveSetFighterSelections`'s forward-carry
  // doc comment for why padding with defaults is safe: an empty row never
  // has its own fighterId/opponentFighterId, so it always inherits).
  // Plain per-render computation (not useMemo) — mirrors `visibleGameNumbers`
  // just above: cheap enough (≤5 games) that memoizing isn't worth it, and
  // it sidesteps a real conflict between React Compiler's manual-memoization
  // preservation check and `updateGame`'s array-index assignment below.
  const resolvedGamePadded = visibleGameNumbers.map(
    (gameNumber) => allGames[gameNumber - 1] ?? buildDefaultGameValues(),
  );
  const resolvedGameFighters = resolveSetFighterSelections(
    { fighterId: sharedFighterId, opponentFighterId: sharedOpponentFighterId },
    resolvedGamePadded,
  );

  // Writes into the EDITABLE `games` array only — `index` is the offset
  // index (see call sites below: `gameNumber - 1 - locked.length`), never a
  // raw game number. Locked games are never written through this path.
  function updateGame(index: number, patch: Partial<SetGameValues>) {
    const next = [...games];
    next[index] = { ...(next[index] ?? buildDefaultGameValues()), ...patch };
    onGamesChange(next);
  }

  function handleFormatChange(nextFormat: SetFormat) {
    form.setValue('format', nextFormat);
    // Trim any games that are no longer reachable under the new format
    // (e.g. switching Bo5 -> Bo3 after game 4 was entered). A locked game is
    // never dropped by a format change — only the EDITABLE budget shrinks.
    onGamesChange(games.slice(0, Math.max(0, maxGamesFor(nextFormat) - locked.length)));
  }

  async function handleSubmit(values: SetSharedFormValues) {
    const shared = sharedFormToSetShared(values);
    const playedNewGames = games
      .slice(0, Math.max(0, visibleGameNumbers.length - locked.length))
      .filter((g) => g.result);
    const payloads = buildContinuationPayloads(shared, locked, playedNewGames);
    await onSubmit(payloads);
  }

  const { data: stageFavorites } = useStageFavorites();
  const toggleStageFavorite = useToggleStageFavorite();
  const favoriteStageIds = stageFavorites?.stageIds;
  const stageGroups = useMemo(
    () => getGroupedStageOptions(allMatches, favoriteStageIds, TOURNAMENT_LEGAL_STAGE_IDS),
    [allMatches, favoriteStageIds],
  );

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} noValidate>
        <div className="flex flex-col gap-4">
          <FormItem>
            <FormLabel>{t('matchForm.set.format')}</FormLabel>
            <FormControl>
              <ToggleGroup
                type="single"
                variant="outline"
                value={format}
                onValueChange={(value) => {
                  if (value) handleFormatChange(value as SetFormat);
                }}
              >
                <ToggleGroupItem
                  value="bo3"
                  aria-label={t('matchForm.set.bestOf3')}
                  disabled={!isFormatSelectable('bo3', locked.length)}
                >
                  Bo3
                </ToggleGroupItem>
                <ToggleGroupItem
                  value="bo5"
                  aria-label={t('matchForm.set.bestOf5')}
                  disabled={!isFormatSelectable('bo5', locked.length)}
                >
                  Bo5
                </ToggleGroupItem>
              </ToggleGroup>
            </FormControl>
          </FormItem>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="fighterId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('matchForm.yourFighter')}</FormLabel>
                  <Select
                    value={String(field.value)}
                    onValueChange={(v) => field.onChange(Number(v))}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {fighterSprites.map((s) => (
                        <SelectItem key={s.id} value={String(s.id)}>
                          <img src={s.url} alt="" className="size-6 object-contain" />
                          {localizedFighterName(s.id, t)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="opponentFighterId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('matchForm.set.opponentFighterGame1')}</FormLabel>
                  <Select
                    value={String(field.value)}
                    onValueChange={(v) => field.onChange(Number(v))}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {alphaFighters.map((s) => (
                        <SelectItem key={s.id} value={String(s.id)}>
                          <img src={s.url} alt="" className="size-6 object-contain" />
                          {localizedFighterName(s.id, t)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <FormField
            control={form.control}
            name="matchType"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('matchForm.matchType')}</FormLabel>
                <FormControl>
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    value={field.value}
                    onValueChange={(value) => {
                      if (value) field.onChange(value);
                    }}
                    className="flex flex-wrap justify-start"
                  >
                    {matchTypeValues.map((value) => (
                      <ToggleGroupItem key={value} value={value}>
                        {matchTypeLabel(t, value)}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="opponentName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('matchForm.opponent')}</FormLabel>
                <Popover open={opponentPopoverOpen} onOpenChange={setOpponentPopoverOpen}>
                  <PopoverTrigger asChild>
                    <FormControl>
                      <Button
                        type="button"
                        variant="outline"
                        role="combobox"
                        aria-expanded={opponentPopoverOpen}
                        className="w-full justify-between font-normal"
                      >
                        {field.value || t('matchForm.opponentCombobox')}
                        <ChevronsUpDown className="opacity-50" />
                      </Button>
                    </FormControl>
                  </PopoverTrigger>
                  <PopoverContent className="w-[--radix-popover-trigger-width] p-0">
                    <Command>
                      <CommandInput
                        placeholder={t('matchForm.opponentSearch')}
                        value={field.value}
                        onValueChange={(value) => field.onChange(value)}
                        // Select-all on focus — same rationale as the
                        // single-game form: 'unknown' arrives pre-filled and
                        // typing should replace it.
                        onFocus={(e) => e.currentTarget.select()}
                        // cmdk's own Enter handling only fires an item's
                        // onSelect when a suggestion is highlighted — typing
                        // a brand-new name (no match in the list) leaves
                        // nothing highlighted, so Enter silently did nothing
                        // visible even though field.value was already
                        // correct. Explicitly commit the typed value and
                        // close the popover on Enter so free text is never
                        // left hanging; preventDefault covers the
                        // (portalled, so unlikely anyway) risk of a stray
                        // form submit. Doesn't interfere with selecting an
                        // actual highlighted suggestion — that still runs
                        // via cmdk's own Enter listener on the Command root,
                        // since we don't stopPropagation.
                        onKeyDown={(e) => {
                          if (e.key !== 'Enter') return;
                          e.preventDefault();
                          field.onChange(field.value);
                          setOpponentPopoverOpen(false);
                        }}
                      />
                      <CommandList>
                        <CommandEmpty>{t('matchForm.opponentAddHint')}</CommandEmpty>
                        <CommandGroup>
                          {opponents.map((name) => (
                            <CommandItem
                              key={name}
                              value={name}
                              onSelect={(value) => {
                                field.onChange(value);
                                setOpponentPopoverOpen(false);
                              }}
                            >
                              <Check
                                className={cn(field.value === name ? 'opacity-100' : 'opacity-0')}
                              />
                              {name}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
                <FormMessage />
              </FormItem>
            )}
          />

          <TournamentFields control={form.control} />

          <div className="flex items-center justify-between rounded-md border px-3 py-2">
            <span className="text-sm font-medium">{t('matchForm.set.score')}</span>
            <Badge variant={decided ? 'success' : 'secondary'} data-testid="set-score-chip">
              {formatSetScore(score)}{' '}
              {decided ? t('matchForm.set.decided') : t('matchForm.set.firstTo', { count: needed })}
            </Badge>
          </div>

          {locked.length > 0 && decided && noEditableRowVisible && (
            <p className="text-sm text-muted-foreground" data-testid="continue-set-already-decided">
              {t('matchForm.continueSet.alreadyDecided')}
            </p>
          )}

          <div className="flex flex-col gap-4">
            {locked.length > 0 && (
              <div className="flex flex-col gap-2">
                {locked.map((lockedGame, lockedIndex) => {
                  const gameNumber = lockedIndex + 1;
                  const stage =
                    stageOptions.find((s) => s.id === lockedGame.stageId) ?? NO_SELECTION_STAGE;
                  return (
                    <div
                      key={gameNumber}
                      data-testid={`locked-game-${gameNumber}`}
                      className="flex items-center justify-between gap-3 rounded-md border bg-muted/40 p-3"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold">
                          {t('matchForm.set.game', { number: gameNumber })}
                        </span>
                        <Badge variant={lockedGame.result === 'win' ? 'success' : 'secondary'}>
                          {lockedGame.result === 'win' ? t('common.win') : t('common.loss')}
                        </Badge>
                        <span className="text-sm text-muted-foreground">{stage.name}</span>
                        <Badge variant="outline">{t('matchForm.continueSet.saved')}</Badge>
                      </div>
                      {onDropLockedGame && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('matchForm.continueSet.removeGame', {
                            number: gameNumber,
                          })}
                          onClick={() => onDropLockedGame(gameNumber - 1)}
                        >
                          <X />
                        </Button>
                      )}
                    </div>
                  );
                })}
                {onClearLockedGames && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="self-start"
                    onClick={onClearLockedGames}
                  >
                    {t('matchForm.continueSet.clearContext')}
                  </Button>
                )}
              </div>
            )}

            {visibleGameNumbers
              .filter((gameNumber) => gameNumber > locked.length)
              .map((gameNumber) => {
                const index = gameNumber - 1;
                const editableIndex = gameNumber - 1 - locked.length;
                const game = games[editableIndex] ?? buildDefaultGameValues();
                const resolvedFighters = resolvedGameFighters[index];
                return (
                  <div key={gameNumber} className="flex flex-col gap-3 rounded-md border p-3">
                    <span className="text-sm font-semibold">
                      {t('matchForm.set.game', { number: gameNumber })}
                    </span>

                    {resolvedFighters && (
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <FormItem>
                          <FormLabel>{t('matchForm.set.gameYourFighter')}</FormLabel>
                          <Select
                            value={String(resolvedFighters.fighterId)}
                            onValueChange={(v) =>
                              updateGame(editableIndex, { fighterId: Number(v) })
                            }
                          >
                            <FormControl>
                              <SelectTrigger
                                className="w-full"
                                aria-label={t('matchForm.set.gameYourFighterAria', {
                                  number: gameNumber,
                                })}
                              >
                                <SelectValue />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {fighterSprites.map((s) => (
                                <SelectItem key={s.id} value={String(s.id)}>
                                  <img src={s.url} alt="" className="size-6 object-contain" />
                                  {localizedFighterName(s.id, t)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </FormItem>
                        <FormItem>
                          <FormLabel>{t('matchForm.set.gameOpponentFighter')}</FormLabel>
                          <Select
                            value={String(resolvedFighters.opponentFighterId)}
                            onValueChange={(v) =>
                              updateGame(editableIndex, { opponentFighterId: Number(v) })
                            }
                          >
                            <FormControl>
                              <SelectTrigger
                                className="w-full"
                                aria-label={t('matchForm.set.gameOpponentFighterAria', {
                                  number: gameNumber,
                                })}
                              >
                                <SelectValue />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {alphaFighters.map((s) => (
                                <SelectItem key={s.id} value={String(s.id)}>
                                  <img src={s.url} alt="" className="size-6 object-contain" />
                                  {localizedFighterName(s.id, t)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </FormItem>
                      </div>
                    )}

                    <FormItem>
                      <FormLabel>{t('matchForm.result')}</FormLabel>
                      <ToggleGroup
                        type="single"
                        variant="outline"
                        value={game.result ?? ''}
                        onValueChange={(value) => {
                          if (value) updateGame(editableIndex, { result: value as 'win' | 'loss' });
                        }}
                      >
                        <ToggleGroupItem
                          value="win"
                          aria-label={t('matchForm.set.gameWinAria', { number: gameNumber })}
                        >
                          {t('common.win')}
                        </ToggleGroupItem>
                        <ToggleGroupItem
                          value="loss"
                          aria-label={t('matchForm.set.gameLossAria', { number: gameNumber })}
                        >
                          {t('common.loss')}
                        </ToggleGroupItem>
                      </ToggleGroup>
                    </FormItem>

                    <FormItem>
                      <FormLabel>{t('matchForm.set.stage')}</FormLabel>
                      <Select
                        value={String(game.stageId)}
                        onValueChange={(v) => updateGame(editableIndex, { stageId: Number(v) })}
                      >
                        <FormControl>
                          <SelectTrigger className="w-full">
                            <StageSelectValue stageId={game.stageId} />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <StageSelectGroups
                            groups={stageGroups}
                            onToggleFavorite={toggleStageFavorite}
                          />
                        </SelectContent>
                      </Select>
                    </FormItem>

                    <FormItem>
                      <FormLabel>{t('matchForm.stageForm.label')}</FormLabel>
                      <ToggleGroup
                        type="single"
                        variant="outline"
                        value={game.stageForm ?? ''}
                        onValueChange={(value) =>
                          updateGame(editableIndex, {
                            stageForm: value
                              ? (value as 'normal' | 'battlefield' | 'omega')
                              : undefined,
                          })
                        }
                      >
                        <ToggleGroupItem value="normal">
                          {t('matchForm.stageForm.normal')}
                        </ToggleGroupItem>
                        <ToggleGroupItem value="battlefield">
                          {t('matchForm.stageForm.battlefield')}
                        </ToggleGroupItem>
                        <ToggleGroupItem value="omega">
                          {t('matchForm.stageForm.omega')}
                        </ToggleGroupItem>
                      </ToggleGroup>
                    </FormItem>

                    <FormItem>
                      <FormLabel>{t('matchForm.stocksLeft')}</FormLabel>
                      <Select
                        value={game.stocksLeft === undefined ? 'unset' : String(game.stocksLeft)}
                        onValueChange={(v) =>
                          updateGame(editableIndex, {
                            stocksLeft: v === 'unset' ? undefined : Number(v),
                          })
                        }
                      >
                        <FormControl>
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder={t('matchForm.notTracked')} />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="unset">{t('matchForm.notTracked')}</SelectItem>
                          {[0, 1, 2, 3].map((n) => (
                            <SelectItem key={n} value={String(n)}>
                              {n}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormItem>

                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <FormItem>
                        <FormLabel>{t('matchForm.set.vodUrl')}</FormLabel>
                        <FormControl>
                          <Input
                            type="url"
                            value={game.vodUrl ?? ''}
                            onChange={(e) => updateGame(editableIndex, { vodUrl: e.target.value })}
                            placeholder={t('matchForm.vodUrlPlaceholder')}
                          />
                        </FormControl>
                      </FormItem>

                      <FormItem>
                        <FormLabel>{t('matchForm.set.vodStartTime')}</FormLabel>
                        <FormControl>
                          <Input
                            type="text"
                            value={game.vodStartSeconds ?? ''}
                            onChange={(e) =>
                              updateGame(editableIndex, { vodStartSeconds: e.target.value })
                            }
                            disabled={!game.vodUrl?.trim()}
                            placeholder={t('matchForm.vodStartSeconds.placeholder')}
                          />
                        </FormControl>
                      </FormItem>
                    </div>
                  </div>
                );
              })}
          </div>
        </div>

        {footer}
      </form>
    </Form>
  );
}
