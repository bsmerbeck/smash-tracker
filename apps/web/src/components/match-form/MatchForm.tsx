import { useMemo, useState } from 'react';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
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
  SelectItem,
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
import { StageSelectGroups } from '@/components/StageSelectGroups';
import { useOpponents } from '@/hooks/useOpponents';
import { useMatches } from '@/hooks/useMatches';
import { useStageFavorites } from '@/hooks/useStageFavorites';
import { getGroupedStageOptions, stageOptions } from '@/lib/stageOptions';
import { parseGspNumber } from '@/pages/Gsp/lib/parseGspNumber';

export const alphaSpriteList = [...SpriteList].sort((a, b) => a.name.localeCompare(b.name));

export { stageOptions };

/**
 * Legacy-style banner preview of the currently selected stage's artwork,
 * shown under the stage select. Renders nothing for the no-selection
 * sentinel or stages without art.
 */
export function StageArtPreview({ stageId }: { stageId: number }) {
  const stage = stageOptions.find((s) => s.id === stageId);
  // The no-selection sentinel has no `url` property at all; art-less stages
  // have an empty one — render nothing for either.
  if (!stage || !('url' in stage) || !stage.url) {
    return null;
  }
  return (
    <img
      src={stage.url}
      alt={stage.name}
      className="mt-2 aspect-video max-h-32 w-full rounded-md border object-cover"
    />
  );
}

/** Translated label for a shared match-type enum value (locale keys mirror the enum literals, hyphens included). */
export function matchTypeLabel(t: TFunction, value: (typeof matchTypeValues)[number]): string {
  return t(`matchForm.matchTypes.${value}`);
}

/**
 * Form-level validation schema, shared by AddMatchForm and EditMatchForm.
 * Values here are UI-shaped (result is a separate win/loss toggle instead of
 * a boolean, stage/fighter ids are numbers) and get mapped to
 * `CreateMatchInput`/`UpdateMatchInput` by callers — including lowercasing
 * the opponent name, exactly as legacy did in `updateOpponent`.
 *
 * A factory (not a module constant) so validation messages come out of the
 * active locale; `useMatchForm` rebuilds it per render with the current `t`.
 */
export function buildMatchFormSchema(t: TFunction) {
  return z.object({
    fighterId: z
      .number()
      .int()
      .positive({ message: t('matchForm.validation.chooseFighter') }),
    opponentFighterId: z
      .number()
      .int()
      .positive({ message: t('matchForm.validation.chooseOpponentFighter') }),
    result: z.enum(['win', 'loss'], { message: t('matchForm.validation.chooseResult') }),
    stageId: z.number().int().nonnegative(),
    matchType: z.enum(matchTypeValues),
    opponentName: z.string().min(1, t('matchForm.validation.opponentRequired')),
    notes: z.string().max(100, t('matchForm.validation.charLimit', { max: 100 })),
    /** Winner's remaining stocks, 0-3. `undefined`/`''` (the "not tracked" state) is allowed — see `STOCKS_NOT_TRACKED`. */
    stocksLeft: z.number().int().min(0).max(3).optional(),
    eventName: z
      .string()
      .max(80, t('matchForm.validation.charLimit', { max: 80 }))
      .optional(),
    tournamentName: z
      .string()
      .max(80, t('matchForm.validation.charLimit', { max: 80 }))
      .optional(),
    /** GSP shown on the results screen, held as the user's raw text (commas/spaces tolerated — see parseGspNumber); '' = not tracked. */
    gsp: z.string().refine((value) => value.trim() === '' || parseGspNumber(value) !== null, {
      message: t('matchForm.validation.gspFormat'),
    }),
  });
}

export type MatchFormValues = z.infer<ReturnType<typeof buildMatchFormSchema>>;

/** Sentinel select value meaning "stocks not tracked for this game" — HTML selects need a string, and `''` reads naturally as unset. */
export const STOCKS_NOT_TRACKED = 'unset';

/** Maps form values to the API's `CreateMatchInput`/`UpdateMatchInput` shape (identical field set). Blank optional strings are omitted, never sent as `''` (the server schema does the same normalization, but omitting client-side keeps payload assertions in tests simple). */
export function matchFormValuesToInput(values: MatchFormValues): CreateMatchInput {
  const stage = stageOptions.find((s) => s.id === values.stageId) ?? NO_SELECTION_STAGE;
  const eventName = values.eventName?.trim();
  const tournamentName = values.tournamentName?.trim();
  const gsp = values.gsp.trim() === '' ? null : parseGspNumber(values.gsp);
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
    ...(gsp !== null ? { gsp } : {}),
  };
}

export function useMatchForm(defaultValues: MatchFormValues): UseFormReturn<MatchFormValues> {
  const { t } = useTranslation();
  return useForm<MatchFormValues>({
    resolver: zodResolver(buildMatchFormSchema(t)),
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
  label,
}: {
  control: UseFormReturn<TFieldValues>['control'];
  name?: Parameters<typeof FormField<TFieldValues>>[0]['name'];
  label?: string;
}) {
  const { t } = useTranslation();
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => {
        const value = field.value as number | undefined;
        return (
          <FormItem>
            <FormLabel>{label ?? t('matchForm.stocksLeft')}</FormLabel>
            <Select
              value={value === undefined ? STOCKS_NOT_TRACKED : String(value)}
              onValueChange={(v) =>
                field.onChange(v === STOCKS_NOT_TRACKED ? undefined : Number(v))
              }
            >
              <FormControl>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={t('matchForm.notTracked')} />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                <SelectItem value={STOCKS_NOT_TRACKED}>{t('matchForm.notTracked')}</SelectItem>
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
  const { t } = useTranslation();
  const [open, setOpen] = useState(defaultOpen);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-md border">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium"
        >
          {t('matchForm.tournament.sectionTitle')}
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
                <FormLabel>{t('matchForm.tournament.tournamentName')}</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    value={(field.value as string | undefined) ?? ''}
                    maxLength={80}
                    placeholder={t('matchForm.tournament.tournamentPlaceholder')}
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
                <FormLabel>{t('matchForm.tournament.eventName')}</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    value={(field.value as string | undefined) ?? ''}
                    maxLength={80}
                    placeholder={t('matchForm.tournament.eventPlaceholder')}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <p className="text-xs text-muted-foreground">{t('matchForm.tournament.hint')}</p>
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
  const { t } = useTranslation();
  const { data: opponents = [] } = useOpponents();
  const { data: allMatches = [] } = useMatches();
  const { data: stageFavorites } = useStageFavorites();
  const [opponentPopoverOpen, setOpponentPopoverOpen] = useState(false);

  const favoriteStageIds = stageFavorites?.stageIds;
  const stageGroups = useMemo(
    () => getGroupedStageOptions(allMatches, favoriteStageIds),
    [allMatches, favoriteStageIds],
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
                <FormLabel>{t('matchForm.opponentFighter')}</FormLabel>
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
              <FormLabel>{t('matchForm.result')}</FormLabel>
              <FormControl>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  value={field.value ?? ''}
                  onValueChange={(value) => {
                    if (value) field.onChange(value);
                  }}
                >
                  <ToggleGroupItem value="win" aria-label={t('common.win')}>
                    {t('common.win')}
                  </ToggleGroupItem>
                  <ToggleGroupItem value="loss" aria-label={t('common.loss')}>
                    {t('common.loss')}
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
              <FormLabel>{t('matchForm.map')}</FormLabel>
              <Select value={String(field.value)} onValueChange={(v) => field.onChange(Number(v))}>
                <FormControl>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <StageSelectGroups groups={stageGroups} />
                </SelectContent>
              </Select>
              <StageArtPreview stageId={field.value} />
              <FormMessage />
            </FormItem>
          )}
        />

        <StocksSelectField control={form.control} />

        <FormField
          control={form.control}
          name="gsp"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('matchForm.gspAfterMatch')}</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  type="text"
                  inputMode="numeric"
                  placeholder={t('matchForm.gspPlaceholder')}
                  className="max-w-xs"
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

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

        <TournamentFields control={form.control} />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
                        // Select-all on focus: the field arrives pre-filled
                        // ('unknown' on add, the saved name on edit), so
                        // typing should replace it, not append to it.
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

          <FormField
            control={form.control}
            name="notes"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('matchForm.notes')}</FormLabel>
                <FormControl>
                  <Textarea
                    {...field}
                    maxLength={100}
                    placeholder={t('matchForm.notesPlaceholder')}
                  />
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
