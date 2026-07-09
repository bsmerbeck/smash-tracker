import { useMemo, useState, type ReactNode } from 'react';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Check, ChevronsUpDown } from 'lucide-react';
import type { Fighter } from '@smash-tracker/shared';
import { matchTypeValues } from '@smash-tracker/shared';
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
import { StageSelectGroups } from '@/components/StageSelectGroups';
import { useOpponents } from '@/hooks/useOpponents';
import { useMatches } from '@/hooks/useMatches';
import { useStageFavorites } from '@/hooks/useStageFavorites';
import { getGroupedStageOptions } from '@/lib/stageOptions';
import { alphaSpriteList, TournamentFields, matchTypeLabel } from './MatchForm';
import {
  setFormatValues,
  winsNeededFor,
  maxGamesFor,
  getSetScore,
  isSetDecided,
  shouldShowGame,
  formatSetScore,
  buildSetGamePayloads,
  buildDefaultGameValues,
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

export function defaultSetSharedValues(fighterId: number): SetSharedFormValues {
  return {
    fighterId,
    opponentFighterId: alphaSpriteList[0]?.id ?? 0,
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
}: {
  /** The fighters offered for "Your Fighter" — the signed-in user's primary+secondary selections. */
  fighterSprites: Fighter[];
  form: UseFormReturn<SetSharedFormValues>;
  games: SetGameValues[];
  onGamesChange: (games: SetGameValues[]) => void;
  onSubmit: (payloads: ReturnType<typeof buildSetGamePayloads>) => void | Promise<void>;
  /** Rendered inside the wizard's own `<form>` (e.g. Cancel/Save buttons) so a submit button here triggers `onSubmit` via normal form submission. */
  footer?: ReactNode;
}) {
  const { t } = useTranslation();
  const { data: opponents = [] } = useOpponents();
  const { data: allMatches = [] } = useMatches();
  const [opponentPopoverOpen, setOpponentPopoverOpen] = useState(false);

  const format = form.watch('format');
  const score = useMemo(() => getSetScore(games), [games]);
  const decided = isSetDecided(format, score);
  const needed = winsNeededFor(format);
  const maxGames = maxGamesFor(format);

  const visibleGameNumbers = getVisibleGameNumbers(format, games, maxGames);

  function updateGame(index: number, patch: Partial<SetGameValues>) {
    const next = [...games];
    next[index] = { ...(next[index] ?? buildDefaultGameValues()), ...patch };
    onGamesChange(next);
  }

  function handleFormatChange(nextFormat: SetFormat) {
    form.setValue('format', nextFormat);
    // Trim any games that are no longer reachable under the new format
    // (e.g. switching Bo5 -> Bo3 after game 4 was entered).
    onGamesChange(games.slice(0, maxGamesFor(nextFormat)));
  }

  async function handleSubmit(values: SetSharedFormValues) {
    const shared = sharedFormToSetShared(values);
    const playedGames = games.slice(0, visibleGameNumbers.length).filter((g) => g.result);
    const payloads = buildSetGamePayloads(shared, playedGames);
    await onSubmit(payloads);
  }

  const { data: stageFavorites } = useStageFavorites();
  const favoriteStageIds = stageFavorites?.stageIds;
  const stageGroups = useMemo(
    () => getGroupedStageOptions(allMatches, favoriteStageIds),
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
                <ToggleGroupItem value="bo3" aria-label={t('matchForm.set.bestOf3')}>
                  Bo3
                </ToggleGroupItem>
                <ToggleGroupItem value="bo5" aria-label={t('matchForm.set.bestOf5')}>
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
                          {s.name}
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
                      {alphaSpriteList.map((s) => (
                        <SelectItem key={s.id} value={String(s.id)}>
                          <img src={s.url} alt="" className="size-6 object-contain" />
                          {s.name}
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

          <div className="flex flex-col gap-4">
            {visibleGameNumbers.map((gameNumber) => {
              const index = gameNumber - 1;
              const game = games[index] ?? buildDefaultGameValues();
              return (
                <div key={gameNumber} className="flex flex-col gap-3 rounded-md border p-3">
                  <span className="text-sm font-semibold">
                    {t('matchForm.set.game', { number: gameNumber })}
                  </span>
                  <FormItem>
                    <FormLabel>{t('matchForm.result')}</FormLabel>
                    <ToggleGroup
                      type="single"
                      variant="outline"
                      value={game.result ?? ''}
                      onValueChange={(value) => {
                        if (value) updateGame(index, { result: value as 'win' | 'loss' });
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
                      onValueChange={(v) => updateGame(index, { stageId: Number(v) })}
                    >
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <StageSelectGroups groups={stageGroups} />
                      </SelectContent>
                    </Select>
                  </FormItem>

                  <FormItem>
                    <FormLabel>{t('matchForm.stocksLeft')}</FormLabel>
                    <Select
                      value={game.stocksLeft === undefined ? 'unset' : String(game.stocksLeft)}
                      onValueChange={(v) =>
                        updateGame(index, { stocksLeft: v === 'unset' ? undefined : Number(v) })
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
