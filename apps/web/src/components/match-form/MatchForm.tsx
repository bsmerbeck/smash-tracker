import { useMemo, useState } from 'react';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Check, ChevronDown, ChevronsUpDown } from 'lucide-react';
import type { Fighter } from '@smash-tracker/shared';
import { matchTypeValues, type CreateMatchInput } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
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
import { Textarea } from '@/components/ui/textarea';
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { SpriteList } from '@/data/sprites';
import { NO_SELECTION_STAGE } from '@/data/stages';
import { StageOption } from '@/components/StageOption';
import { useOpponents } from '@/hooks/useOpponents';
import { useMatches } from '@/hooks/useMatches';
import { getGroupedStageOptions, stageOptions } from '@/lib/stageOptions';

export const alphaSpriteList = [...SpriteList].sort((a, b) => a.name.localeCompare(b.name));

export { stageOptions };

export const MATCH_TYPE_LABELS: Record<(typeof matchTypeValues)[number], string> = {
  none: 'None',
  quickplay: 'QuickPlay',
  'online-friendly': 'Online Friendly',
  'online-tourney': 'Online Tourney',
  'offline-friendly': 'Offline Friendly',
  'offline-tourney': 'Offline Tourney',
};

/**
 * Form-level validation schema, shared by AddMatchForm and EditMatchForm.
 * Values here are UI-shaped (result is a separate win/loss toggle instead of
 * a boolean, stage/fighter ids are numbers) and get mapped to
 * `CreateMatchInput`/`UpdateMatchInput` by callers — including lowercasing
 * the opponent name, exactly as legacy did in `updateOpponent`.
 */
export const matchFormSchema = z.object({
  fighterId: z.number().int().positive({ message: 'Choose your fighter' }),
  opponentFighterId: z.number().int().positive({ message: "Choose your opponent's fighter" }),
  result: z.enum(['win', 'loss'], { message: 'Choose a result' }),
  stageId: z.number().int().nonnegative(),
  matchType: z.enum(matchTypeValues),
  opponentName: z.string().min(1, 'Opponent name is required'),
  notes: z.string().max(100, 'Limit 100 characters'),
  /** Winner's remaining stocks, 0-3. `undefined`/`''` (the "not tracked" state) is allowed — see `STOCKS_NOT_TRACKED`. */
  stocksLeft: z.number().int().min(0).max(3).optional(),
  eventName: z.string().max(80, 'Limit 80 characters').optional(),
  tournamentName: z.string().max(80, 'Limit 80 characters').optional(),
});

export type MatchFormValues = z.infer<typeof matchFormSchema>;

/** Sentinel select value meaning "stocks not tracked for this game" — HTML selects need a string, and `''` reads naturally as unset. */
export const STOCKS_NOT_TRACKED = 'unset';

/** Maps form values to the API's `CreateMatchInput`/`UpdateMatchInput` shape (identical field set). Blank optional strings are omitted, never sent as `''` (the server schema does the same normalization, but omitting client-side keeps payload assertions in tests simple). */
export function matchFormValuesToInput(values: MatchFormValues): CreateMatchInput {
  const stage = stageOptions.find((s) => s.id === values.stageId) ?? NO_SELECTION_STAGE;
  const eventName = values.eventName?.trim();
  const tournamentName = values.tournamentName?.trim();
  return {
    fighter_id: values.fighterId,
    opponent_id: values.opponentFighterId,
    map: { id: stage.id, name: stage.name },
    opponent: values.opponentName.toLowerCase(),
    notes: values.notes,
    matchType: values.matchType,
    win: values.result === 'win',
    ...(values.stocksLeft !== undefined ? { stocksLeft: values.stocksLeft } : {}),
    ...(eventName ? { eventName } : {}),
    ...(tournamentName ? { tournamentName } : {}),
  };
}

export function useMatchForm(defaultValues: MatchFormValues): UseFormReturn<MatchFormValues> {
  return useForm<MatchFormValues>({
    resolver: zodResolver(matchFormSchema),
    defaultValues,
  });
}

/**
 * Optional "winner's remaining stocks" select (0-3), shared by the
 * single-game form and each per-game row in the set wizard. Modeled as a
 * generic-control field so `SetWizard`'s per-game rows (which don't use
 * `MatchFormValues`) can reuse the same UI via a differently-typed
 * `control`/`name` pair.
 */
export function StocksSelectField<TFieldValues extends Record<string, unknown>>({
  control,
  name = 'stocksLeft' as never,
  label = 'Stocks Left (winner)',
}: {
  control: UseFormReturn<TFieldValues>['control'];
  name?: Parameters<typeof FormField<TFieldValues>>[0]['name'];
  label?: string;
}) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => {
        const value = field.value as number | undefined;
        return (
          <FormItem>
            <FormLabel>{label}</FormLabel>
            <Select
              value={value === undefined ? STOCKS_NOT_TRACKED : String(value)}
              onValueChange={(v) =>
                field.onChange(v === STOCKS_NOT_TRACKED ? undefined : Number(v))
              }
            >
              <FormControl>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Not tracked" />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                <SelectItem value={STOCKS_NOT_TRACKED}>Not tracked</SelectItem>
                {[0, 1, 2, 3].map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        );
      }}
    />
  );
}

/**
 * Collapsible "Tournament" section (event name + tournament name), shared
 * by the single-game form and the set wizard's shared-fields step. Manual
 * entries here land in the same `eventName`/`tournamentName` record fields
 * that start.gg imports populate, so a manually-typed tournament name joins
 * the same tournament views automatically — see the hint text below.
 */
export function TournamentFields<TFieldValues extends Record<string, unknown>>({
  control,
  eventNameField = 'eventName' as never,
  tournamentNameField = 'tournamentName' as never,
  defaultOpen = false,
}: {
  control: UseFormReturn<TFieldValues>['control'];
  eventNameField?: Parameters<typeof FormField<TFieldValues>>[0]['name'];
  tournamentNameField?: Parameters<typeof FormField<TFieldValues>>[0]['name'];
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-md border">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium"
        >
          Tournament (optional)
          <ChevronDown
            className={cn('size-4 transition-transform', open && 'rotate-180')}
            aria-hidden="true"
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-4 border-t px-3 py-3">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField
            control={control}
            name={tournamentNameField}
            render={({ field }) => (
              <FormItem>
                <FormLabel>Tournament Name</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    value={(field.value as string | undefined) ?? ''}
                    maxLength={80}
                    placeholder="e.g. The Big House 9"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={control}
            name={eventNameField}
            render={({ field }) => (
              <FormItem>
                <FormLabel>Event Name</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    value={(field.value as string | undefined) ?? ''}
                    maxLength={80}
                    placeholder="e.g. Ultimate Singles"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Tournament and event names entered here are stored the same way as start.gg imports, so
          manually-tracked tournaments show up alongside synced ones in Tournament views.
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Shared field layout behind AddMatchForm and EditMatchForm — both dialogs
 * differ only in their trigger, title, default values, and submit handler;
 * the fields themselves (fighter/opponent pickers, result toggle, stage,
 * match type, opponent name combobox, notes) are identical, ported from
 * legacy/src/screens/Dashboard/components/DashboardToolbar/components/AddMatchForm
 * and legacy/src/screens/MatchData/components/MatchTable/components/EditMatchForm.
 */
export function MatchFormFields({
  form,
  fighterSprites,
}: {
  form: UseFormReturn<MatchFormValues>;
  /** The fighters offered for "Your Fighter" — the signed-in user's primary+secondary selections. */
  fighterSprites: Fighter[];
}) {
  const { data: opponents = [] } = useOpponents();
  const { data: allMatches = [] } = useMatches();
  const [opponentPopoverOpen, setOpponentPopoverOpen] = useState(false);

  const { mostPlayed, all: allStages } = useMemo(
    () => getGroupedStageOptions(allMatches),
    [allMatches],
  );

  return (
    <Form {...form}>
      <div className="flex flex-col gap-4">
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
                <FormLabel>Opponent Fighter</FormLabel>
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
          name="result"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Result</FormLabel>
              <FormControl>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  value={field.value ?? ''}
                  onValueChange={(value) => {
                    if (value) field.onChange(value);
                  }}
                >
                  <ToggleGroupItem value="win" aria-label="Win">
                    Win
                  </ToggleGroupItem>
                  <ToggleGroupItem value="loss" aria-label="Loss">
                    Loss
                  </ToggleGroupItem>
                </ToggleGroup>
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="stageId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Map</FormLabel>
              <Select value={String(field.value)} onValueChange={(v) => field.onChange(Number(v))}>
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
              <FormMessage />
            </FormItem>
          )}
        />

        <StocksSelectField control={form.control} />

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

        <TournamentFields control={form.control} />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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

          <FormField
            control={form.control}
            name="notes"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Notes</FormLabel>
                <FormControl>
                  <Textarea {...field} maxLength={100} placeholder="Optional notes..." />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
      </div>
    </Form>
  );
}
