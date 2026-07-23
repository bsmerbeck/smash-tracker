import { useMemo, useState, type ReactNode } from 'react';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Check, ChevronDown, ChevronsUpDown } from 'lucide-react';
import type { Fighter } from '@smash-tracker/shared';
import { matchTypeValues, type CreateMatchInput } from '@smash-tracker/shared';
import { Badge } from '@/components/ui/badge';
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
import { StageSelectGroups, StageSelectValue } from '@/components/StageSelectGroups';
import { useOpponents } from '@/hooks/useOpponents';
import { useMatches } from '@/hooks/useMatches';
import { useStageFavorites, useToggleStageFavorite } from '@/hooks/useStageFavorites';
import {
  getGroupedStageOptions,
  stageOptions,
  STANDARD_ONLINE_STAGE_IDS,
} from '@/lib/stageOptions';
import { parseGspNumber } from '@/pages/Gsp/lib/parseGspNumber';
import { parseFlexibleTimestamp } from '@/lib/vod';

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
 *
 * `requireOpponent: false` (EditMatchForm) allows a blank opponent name:
 * quickplay matches logged via the GSP Quick Logger store `opponent: ''`
 * (anonymous randoms), and editing one must not force inventing a name. The
 * server tolerates the blank (`optionalOpponentNameInputSchema` omits it),
 * so the match simply stays anonymous. Manual entry keeps the requirement.
 */
export function buildMatchFormSchema(
  t: TFunction,
  {
    requireOpponent = true,
    requireVod = false,
  }: { requireOpponent?: boolean; requireVod?: boolean } = {},
) {
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
    /**
     * SETFEAT-02: which form of the stage was played (Battlefield/Omega),
     * if the player tracked it. Untouched toggle = `undefined` = no form
     * recorded (see `matchFormValuesToInput`'s conditional-spread).
     */
    stageForm: z.enum(['normal', 'battlefield', 'omega']).optional(),
    matchType: z.enum(matchTypeValues),
    opponentName: requireOpponent
      ? z.string().min(1, t('matchForm.validation.opponentRequired'))
      : z.string(),
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
    /**
     * VOD link (V-Manager fix-up): blank clears it (see
     * `matchFormValuesToInput`'s omission — and `EditMatchForm`'s
     * clear-also-drops-timestamps handling), a non-blank value must be a
     * valid URL. When `requireVod` is true (VOD Manager's Add Match mount),
     * blank is rejected — the whole point of that mount is capturing a link.
     */
    vodUrl: z.string().refine(
      (value) => {
        const trimmed = value.trim();
        return requireVod
          ? trimmed !== '' && z.string().url().safeParse(trimmed).success
          : trimmed === '' || z.string().url().safeParse(trimmed).success;
      },
      {
        message: t(
          requireVod ? 'matchForm.validation.vodUrlRequired' : 'matchForm.validation.vodUrlInvalid',
        ),
      },
    ),
    /**
     * Optional user-typed offset into the VOD where this match begins
     * (V-Manager fix-up #3): only meaningful alongside a non-blank `vodUrl`
     * (see `matchFormValuesToInput`, which omits it when the link is
     * blank — the "clearing the VOD link drops the start time too" rule).
     * Accepts any of `parseFlexibleTimestamp`'s forms; blank is always
     * valid regardless of `vodUrl` so the field never blocks save while
     * disabled.
     */
    vodStartSeconds: z
      .string()
      .refine((value) => value.trim() === '' || parseFlexibleTimestamp(value.trim()) !== null, {
        message: t('matchForm.validation.vodStartSecondsInvalid'),
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
  const vodUrl = values.vodUrl.trim();
  const vodStartSecondsRaw = values.vodStartSeconds.trim();
  const vodStartSeconds =
    vodUrl && vodStartSecondsRaw ? parseFlexibleTimestamp(vodStartSecondsRaw) : null;
  return {
    fighter_id: values.fighterId,
    opponent_id: values.opponentFighterId,
    // SETFEAT-02: `form` is spread in only when the toggle was set — an
    // untouched toggle must yield a `map` with no own `form` key (RTDB
    // rejects `undefined`; see `matchStageSchema`'s doc comment).
    map: {
      id: stage.id,
      name: stage.name,
      ...(values.stageForm ? { form: values.stageForm } : {}),
    },
    opponent: values.opponentName.toLowerCase(),
    notes: values.notes,
    matchType: values.matchType,
    win: values.result === 'win',
    ...(values.stocksLeft !== undefined ? { stocksLeft: values.stocksLeft } : {}),
    ...(eventName ? { eventName } : {}),
    ...(tournamentName ? { tournamentName } : {}),
    ...(gsp !== null ? { gsp } : {}),
    // Blank clears (omitted, never sent as ''/null — see RTDB null-stripping
    // convention). `EditMatchForm` layers on top of this to also drop
    // `vodTimestamps` when the link is cleared (offsets into a video that no
    // longer has a URL are meaningless) and to carry existing timestamps
    // through when the link is merely edited, not cleared.
    ...(vodUrl ? { vodUrl } : {}),
    // `vodStartSeconds` only makes sense alongside a link — clearing `vodUrl`
    // (or leaving the start-time field blank) drops it from the payload too,
    // same clear-on-omit convention as `vodTimestamps` above.
    ...(vodStartSeconds !== null ? { vodStartSeconds } : {}),
  };
}

export function useMatchForm(
  defaultValues: MatchFormValues,
  options?: { requireOpponent?: boolean; requireVod?: boolean },
): UseFormReturn<MatchFormValues> {
  const { t } = useTranslation();
  return useForm<MatchFormValues>({
    resolver: zodResolver(buildMatchFormSchema(t, options)),
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
 * Shared field layout behind AddMatchForm, EditMatchForm, and 02-03's
 * `SelectedMatchMeta` inline edit — differ only in their trigger, title,
 * default values, and submit handler; the fields themselves (fighter/
 * opponent pickers, result toggle, stage, match type, opponent name
 * combobox, notes) are identical, ported from
 * legacy/src/screens/Dashboard/components/DashboardToolbar/components/AddMatchForm
 * and legacy/src/screens/MatchData/components/MatchTable/components/EditMatchForm.
 *
 * Sync-owned field set (`syncLocked`) mirrors `changesSyncOwnedFields`
 * (apps/api/src/services/rtdb.ts) VERBATIM: fighterId (fighter_id),
 * opponentFighterId (opponent_id), stageId (map), opponentName (opponent),
 * matchType, result (win), stocksLeft, eventName + tournamentName
 * (TournamentFields) — each wrapped in its own `<fieldset disabled
 * className="contents">` so layout is unchanged and native controls
 * cascade-disable. Always-editable: notes, vodUrl, vodStartSeconds, gsp.
 * Default `syncLocked=false` means every wrapping fieldset is inert — zero
 * behavior change for AddMatchForm/EditMatchForm.
 */
export function MatchFormFields({
  form,
  fighterSprites,
  syncLocked = false,
  vodStartSecondsAccessory,
  requireVod = false,
}: {
  form: UseFormReturn<MatchFormValues>;
  /** The fighters offered for "Your Fighter" — the signed-in user's primary+secondary selections. */
  fighterSprites: Fighter[];
  /** When true, disables exactly the 9 sync-owned controls (see the doc comment above) — used by `SelectedMatchMeta` on synced matches. */
  syncLocked?: boolean;
  /** Optional slot rendered adjacent to the vodStartSeconds field (02-03's "Use current player time" button). Default undefined renders nothing — safe no-op for other callers. */
  vodStartSecondsAccessory?: ReactNode;
  /** When true, renders an `aria-hidden` required marker on the VOD URL label and sets `aria-required` on its input — used by the VOD Manager's required-VOD Add Match mount. Default false is a no-op for every other caller. */
  requireVod?: boolean;
}) {
  const { t } = useTranslation();
  const { data: opponents = [] } = useOpponents();
  const { data: allMatches = [] } = useMatches();
  const { data: stageFavorites } = useStageFavorites();
  const toggleStageFavorite = useToggleStageFavorite();
  const [opponentPopoverOpen, setOpponentPopoverOpen] = useState(false);
  const vodUrlValue = form.watch('vodUrl');
  const vodLinkPresent = vodUrlValue.trim() !== '';

  const favoriteStageIds = stageFavorites?.stageIds;
  const stageGroups = useMemo(
    () => getGroupedStageOptions(allMatches, favoriteStageIds, STANDARD_ONLINE_STAGE_IDS),
    [allMatches, favoriteStageIds],
  );

  return (
    <Form {...form}>
      <div className="flex flex-col gap-4">
        {syncLocked && (
          <Badge variant="outline" className="w-fit">
            {t('matchData.table.synced')}
          </Badge>
        )}
        <fieldset disabled={syncLocked} className="contents">
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
        </fieldset>

        <fieldset disabled={syncLocked} className="contents">
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
        </fieldset>

        <fieldset disabled={syncLocked} className="contents">
          <FormField
            control={form.control}
            name="stageId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('matchForm.map')}</FormLabel>
                <Select
                  value={String(field.value)}
                  onValueChange={(v) => field.onChange(Number(v))}
                >
                  <FormControl>
                    <SelectTrigger className="w-full">
                      <StageSelectValue stageId={field.value} />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <StageSelectGroups
                      groups={stageGroups}
                      onToggleFavorite={toggleStageFavorite}
                    />
                  </SelectContent>
                </Select>
                <StageArtPreview stageId={field.value} />
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="stageForm"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('matchForm.stageForm.label')}</FormLabel>
                <FormControl>
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    value={field.value ?? ''}
                    onValueChange={(value) => field.onChange(value ? value : undefined)}
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
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </fieldset>

        <fieldset disabled={syncLocked} className="contents">
          <StocksSelectField control={form.control} />
        </fieldset>

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

        <fieldset disabled={syncLocked} className="contents">
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
        </fieldset>

        <fieldset disabled={syncLocked} className="contents">
          <TournamentFields control={form.control} />
        </fieldset>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="vodUrl"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  {t('shared.vod.url')}
                  {requireVod && <span aria-hidden="true"> *</span>}
                </FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    type="url"
                    placeholder={t('matchForm.vodUrlPlaceholder')}
                    aria-required={requireVod || undefined}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="vodStartSeconds"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('matchForm.vodStartSeconds.label')}</FormLabel>
                <div className="flex items-center gap-2">
                  <FormControl>
                    <Input
                      {...field}
                      type="text"
                      disabled={!vodLinkPresent}
                      placeholder={t('matchForm.vodStartSeconds.placeholder')}
                    />
                  </FormControl>
                  {vodStartSecondsAccessory}
                </div>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <fieldset disabled={syncLocked} className="contents">
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
                          // cmdk's own Enter handling only fires an item's
                          // onSelect when a suggestion is highlighted — typing
                          // a brand-new name (no match in the list) leaves
                          // nothing highlighted, so Enter silently did nothing
                          // visible even though field.value was already
                          // correct (human-verify: "hitting enter does not
                          // add the name"). Explicitly commit the typed value
                          // and close the popover on Enter so free text is
                          // never left hanging; preventDefault covers the
                          // (portalled, so unlikely anyway) risk of a stray
                          // form submit. Doesn't interfere with selecting an
                          // actual highlighted suggestion — that still runs
                          // via cmdk's own Enter listener on the Command
                          // root, since we don't stopPropagation.
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
          </fieldset>

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
