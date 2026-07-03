import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Check, ChevronsUpDown } from 'lucide-react';
import { matchTypeValues, type CreateMatchInput } from '@smash-tracker/shared';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
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
import { useCreateMatch } from '@/hooks/useCreateMatch';
import { useOpponents } from '@/hooks/useOpponents';
import { useDashboardContext } from '../DashboardContext';

const alphaSpriteList = [...SpriteList].sort((a, b) => a.name.localeCompare(b.name));

/**
 * `StageList` intentionally keeps legacy's duplicate entries for ids
 * 114-116 (see apps/web/src/data/stages.ts) since production match data may
 * reference either occurrence. A `<select>`-style picker UI has no use for
 * showing the same stage twice, though, so this dropdown's option list is
 * deduplicated by id (first occurrence wins, same as `stagesById`).
 */
const alphaStageList = [...stagesById.values()].sort((a, b) => a.name.localeCompare(b.name));
const stageOptions = [NO_SELECTION_STAGE, ...alphaStageList];

const MATCH_TYPE_LABELS: Record<(typeof matchTypeValues)[number], string> = {
  none: 'None',
  quickplay: 'QuickPlay',
  'online-friendly': 'Online Friendly',
  'online-tourney': 'Online Tourney',
  'offline-friendly': 'Offline Friendly',
  'offline-tourney': 'Offline Tourney',
};

/**
 * Form-level validation schema. Values here are UI-shaped (result is a
 * separate win/loss toggle instead of a boolean, stage/fighter ids are
 * numbers) and get mapped to `CreateMatchInput` in `onSubmit` — including
 * lowercasing the opponent name, exactly as legacy did in `updateOpponent`.
 */
const formSchema = z.object({
  fighterId: z.number().int().positive({ message: 'Choose your fighter' }),
  opponentFighterId: z.number().int().positive({ message: "Choose your opponent's fighter" }),
  result: z.enum(['win', 'loss'], { message: 'Choose a result' }),
  stageId: z.number().int().nonnegative(),
  matchType: z.enum(matchTypeValues),
  opponentName: z.string().min(1, 'Opponent name is required'),
  notes: z.string().max(100, 'Limit 100 characters'),
});

type FormValues = z.infer<typeof formSchema>;

/**
 * Ports legacy/src/screens/Dashboard/components/DashboardToolbar/components/AddMatchForm.
 * Opens from a trigger button in the dashboard toolbar; submits via
 * useCreateMatch (which invalidates matches + opponents so a newly typed
 * opponent name shows up next time).
 */
export function AddMatchForm() {
  const { fighter, fighterSprites } = useDashboardContext();
  const { data: opponents = [] } = useOpponents();
  const createMatch = useCreateMatch();
  const [open, setOpen] = useState(false);
  const [opponentPopoverOpen, setOpponentPopoverOpen] = useState(false);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      fighterId: fighter?.id ?? fighterSprites[0]?.id ?? 0,
      opponentFighterId: alphaSpriteList[0]?.id ?? 0,
      result: undefined,
      stageId: NO_SELECTION_STAGE.id,
      matchType: 'none',
      opponentName: '',
      notes: '',
    },
  });

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      form.reset({
        fighterId: fighter?.id ?? fighterSprites[0]?.id ?? 0,
        opponentFighterId: alphaSpriteList[0]?.id ?? 0,
        result: undefined,
        stageId: NO_SELECTION_STAGE.id,
        matchType: 'none',
        opponentName: '',
        notes: '',
      });
    }
  }

  async function onSubmit(values: FormValues) {
    const stage = stageOptions.find((s) => s.id === values.stageId) ?? NO_SELECTION_STAGE;
    const input: CreateMatchInput = {
      fighter_id: values.fighterId,
      opponent_id: values.opponentFighterId,
      map: { id: stage.id, name: stage.name },
      opponent: values.opponentName.toLowerCase(),
      notes: values.notes,
      matchType: values.matchType,
      win: values.result === 'win',
    };
    try {
      await createMatch.mutateAsync(input);
      toast.success('Match added!');
      setOpen(false);
    } catch {
      toast.error('Failed to add match. Please try again.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button disabled={fighterSprites.length === 0}>Add Match</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add Match</DialogTitle>
          <DialogDescription>Record the outcome of a match you just played.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
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
                                    className={cn(
                                      field.value === name ? 'opacity-100' : 'opacity-0',
                                    )}
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

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createMatch.isPending}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
