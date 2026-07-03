import { useState } from 'react';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Check, ChevronsUpDown } from 'lucide-react';
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
import { SpriteList } from '@/data/sprites';
import { stagesById, NO_SELECTION_STAGE } from '@/data/stages';
import { useOpponents } from '@/hooks/useOpponents';

export const alphaSpriteList = [...SpriteList].sort((a, b) => a.name.localeCompare(b.name));

/**
 * `StageList` intentionally keeps legacy's duplicate entries for ids
 * 114-116 (see apps/web/src/data/stages.ts) since production match data may
 * reference either occurrence. A `<select>`-style picker UI has no use for
 * showing the same stage twice, though, so this dropdown's option list is
 * deduplicated by id (first occurrence wins, same as `stagesById`).
 */
const alphaStageList = [...stagesById.values()].sort((a, b) => a.name.localeCompare(b.name));
export const stageOptions = [NO_SELECTION_STAGE, ...alphaStageList];

const MATCH_TYPE_LABELS: Record<(typeof matchTypeValues)[number], string> = {
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
});

export type MatchFormValues = z.infer<typeof matchFormSchema>;

/** Maps form values to the API's `CreateMatchInput`/`UpdateMatchInput` shape (identical field set). */
export function matchFormValuesToInput(values: MatchFormValues): CreateMatchInput {
  const stage = stageOptions.find((s) => s.id === values.stageId) ?? NO_SELECTION_STAGE;
  return {
    fighter_id: values.fighterId,
    opponent_id: values.opponentFighterId,
    map: { id: stage.id, name: stage.name },
    opponent: values.opponentName.toLowerCase(),
    notes: values.notes,
    matchType: values.matchType,
    win: values.result === 'win',
  };
}

export function useMatchForm(defaultValues: MatchFormValues): UseFormReturn<MatchFormValues> {
  return useForm<MatchFormValues>({
    resolver: zodResolver(matchFormSchema),
    defaultValues,
  });
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
  const [opponentPopoverOpen, setOpponentPopoverOpen] = useState(false);

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
                  {stageOptions.map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
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
