import { useMemo, useState, type ReactNode } from 'react';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
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
  SelectGroup,
  SelectItem,
  SelectLabel,
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
import { NO_SELECTION_STAGE } from '@/data/stages';
import { StageOption } from '@/components/StageOption';
import { useOpponents } from '@/hooks/useOpponents';
import { useMatches } from '@/hooks/useMatches';
import { getGroupedStageOptions } from '@/lib/stageOptions';
import { alphaSpriteList, TournamentFields, MATCH_TYPE_LABELS } from './MatchForm';
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

/** Validation for the fields entered once per set (fighter, opponent, match type, tournament). */
export const setSharedFormSchema = z.object({
  fighterId: z.number().int().positive({ message: 'Choose your fighter' }),
  opponentFighterId: z.number().int().positive({ message: "Choose your opponent's fighter" }),
  opponentName: z.string().min(1, 'Opponent name is required'),
  matchType: z.enum(matchTypeValues),
  format: z.enum(setFormatValues),
  eventName: z.string().max(80, 'Limit 80 characters').optional(),
  tournamentName: z.string().max(80, 'Limit 80 characters').optional(),
});
export type SetSharedFormValues = z.infer<typeof setSharedFormSchema>;

export function useSetSharedForm(
  defaultValues: SetSharedFormValues,
): UseFormReturn<SetSharedFormValues> {
  return useForm<SetSharedFormValues>({
    resolver: zodResolver(setSharedFormSchema),
    defaultValues,
  });
}

export function defaultSetSharedValues(fighterId: number): SetSharedFormValues {
  return {
    fighterId,
    opponentFighterId: alphaSpriteList[0]?.id ?? 0,
    opponentName: '',
    matchType: 'none',
    format: 'bo3',
    eventName: '',
    tournamentName: '',
  };
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
  const { data: opponents = [] } = useOpponents();
  const { data: allMatches = [] } = useMatches();
  const [opponentPopoverOpen, setOpponentPopoverOpen] = useState(false);

  const format = form.watch('format');
  const score = useMemo(() => getSetScore(games), [games]);
  const decided = isSetDecided(format, score);
  const needed = winsNeededFor(format);
  const maxGames = maxGamesFor(format);

  const visibleGameNumbers = useMemo(() => {
    const numbers: number[] = [];
    for (let n = 1; n <= maxGames; n += 1) {
      if (shouldShowGame(format, n, games)) {
        numbers.push(n);
      } else {
        break;
      }
    }
    return numbers;
  }, [format, games, maxGames]);

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

  const { mostPlayed, all: allStages } = useMemo(
    () => getGroupedStageOptions(allMatches),
    [allMatches],
  );

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} noValidate>
        <div className="flex flex-col gap-4">
          <FormItem>
            <FormLabel>Set Format</FormLabel>
            <FormControl>
              <ToggleGroup
                type="single"
                variant="outline"
                value={format}
                onValueChange={(value) => {
                  if (value) handleFormatChange(value as SetFormat);
                }}
              >
                <ToggleGroupItem value="bo3" aria-label="Best of 3">
                  Bo3
                </ToggleGroupItem>
                <ToggleGroupItem value="bo5" aria-label="Best of 5">
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
                  <FormLabel>Your Fighter</FormLabel>
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
                  <FormLabel>Opponent Fighter (game 1)</FormLabel>
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
                <FormLabel>Match Type</FormLabel>
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
                        {MATCH_TYPE_LABELS[value]}
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
                <FormLabel>Opponent</FormLabel>
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
                        {field.value || 'Type to filter or add...'}
                        <ChevronsUpDown className="opacity-50" />
                      </Button>
                    </FormControl>
                  </PopoverTrigger>
                  <PopoverContent className="w-[--radix-popover-trigger-width] p-0">
                    <Command>
                      <CommandInput
                        placeholder="Type a name..."
                        value={field.value}
                        onValueChange={(value) => field.onChange(value)}
                      />
                      <CommandList>
                        <CommandEmpty>Press enter to add a new opponent.</CommandEmpty>
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
            <span className="text-sm font-medium">Set score</span>
            <Badge variant={decided ? 'success' : 'secondary'} data-testid="set-score-chip">
              {formatSetScore(score)}
              {decided ? ' — set decided' : ` (first to ${needed})`}
            </Badge>
          </div>

          <div className="flex flex-col gap-4">
            {visibleGameNumbers.map((gameNumber) => {
              const index = gameNumber - 1;
              const game = games[index] ?? buildDefaultGameValues();
              return (
                <div key={gameNumber} className="flex flex-col gap-3 rounded-md border p-3">
                  <span className="text-sm font-semibold">Game {gameNumber}</span>
                  <FormItem>
                    <FormLabel>Result</FormLabel>
                    <ToggleGroup
                      type="single"
                      variant="outline"
                      value={game.result ?? ''}
                      onValueChange={(value) => {
                        if (value) updateGame(index, { result: value as 'win' | 'loss' });
                      }}
                    >
                      <ToggleGroupItem value="win" aria-label={`Game ${gameNumber} Win`}>
                        Win
                      </ToggleGroupItem>
                      <ToggleGroupItem value="loss" aria-label={`Game ${gameNumber} Loss`}>
                        Loss
                      </ToggleGroupItem>
                    </ToggleGroup>
                  </FormItem>

                  <FormItem>
                    <FormLabel>Stage</FormLabel>
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
                        <SelectItem value={String(NO_SELECTION_STAGE.id)}>
                          {NO_SELECTION_STAGE.name}
                        </SelectItem>
                        {mostPlayed.length > 0 && (
                          <SelectGroup>
                            <SelectLabel>Most played</SelectLabel>
                            {mostPlayed.map((s) => (
                              <SelectItem key={`most-played-${s.id}`} value={String(s.id)}>
                                <StageOption stage={s} />
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        )}
                        <SelectGroup>
                          <SelectLabel>All stages</SelectLabel>
                          {allStages.map((s) => (
                            <SelectItem key={`all-${s.id}`} value={String(s.id)}>
                              <StageOption stage={s} />
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </FormItem>

                  <FormItem>
                    <FormLabel>Stocks Left (winner)</FormLabel>
                    <Select
                      value={game.stocksLeft === undefined ? 'unset' : String(game.stocksLeft)}
                      onValueChange={(v) =>
                        updateGame(index, { stocksLeft: v === 'unset' ? undefined : Number(v) })
                      }
                    >
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Not tracked" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="unset">Not tracked</SelectItem>
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
