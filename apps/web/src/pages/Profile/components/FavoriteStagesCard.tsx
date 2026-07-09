import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ChevronsUpDown, X } from 'lucide-react';
import type { Stage } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { StageOption } from '@/components/StageOption';
import { getStageById } from '@/data/stages';
import { alphaStageList } from '@/lib/stageOptions';
import { useStageFavorites, useUpdateStageFavorites } from '@/hooks/useStageFavorites';

/**
 * Profile > Favorite Stages: manage the stages pinned to the top of every
 * stage picker (Add/Edit Match, set wizard, stage breakdown filter) — the
 * quickplay/Elite Smash rotation is a handful of stages, so pinning them
 * beats scrolling the full ~120-stage list on every log. Favorites keep the
 * order they were added in, which is the order pickers show them.
 */
export function FavoriteStagesCard() {
  const { t } = useTranslation();
  const { data: favorites, isLoading } = useStageFavorites();
  const update = useUpdateStageFavorites();
  const [addOpen, setAddOpen] = useState(false);

  const stageIds = favorites?.stageIds ?? [];
  const favoriteStages = stageIds
    .map((id) => getStageById(id))
    .filter((stage): stage is Stage => stage != null);
  const addableStages = alphaStageList.filter((stage) => !stageIds.includes(stage.id));

  function save(nextIds: number[]) {
    update.mutate(
      { stageIds: nextIds },
      {
        onError: () => toast.error(t('profile.favoriteStages.saveError')),
      },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('profile.favoriteStages.title')}</CardTitle>
        <CardDescription>{t('profile.favoriteStages.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">{t('profile.favoriteStages.loading')}</p>
        ) : favoriteStages.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('profile.favoriteStages.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {favoriteStages.map((stage) => (
              <li
                key={stage.id}
                className="flex items-center justify-between gap-2 rounded-md border p-2"
              >
                <StageOption stage={stage} />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t('profile.favoriteStages.removeAria', { name: stage.name })}
                  disabled={update.isPending}
                  onClick={() => save(stageIds.filter((id) => id !== stage.id))}
                >
                  <X />
                </Button>
              </li>
            ))}
          </ul>
        )}

        <Popover open={addOpen} onOpenChange={setAddOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              role="combobox"
              // Combobox is not a name-from-content role, so the visible
              // text doesn't become the accessible name on its own.
              aria-label={t('profile.favoriteStages.addAria')}
              aria-expanded={addOpen}
              disabled={isLoading || update.isPending}
              className="justify-between font-normal"
            >
              {t('profile.favoriteStages.add')}
              <ChevronsUpDown className="opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[--radix-popover-trigger-width] p-0">
            <Command>
              <CommandInput placeholder={t('profile.favoriteStages.searchPlaceholder')} />
              <CommandList>
                <CommandEmpty>{t('profile.favoriteStages.noStage')}</CommandEmpty>
                <CommandGroup>
                  {addableStages.map((stage) => (
                    <CommandItem
                      key={stage.id}
                      // Two stage names exist under two distinct ids each
                      // (Yggdrasil's Altar, Spiral Mountain), and cmdk values
                      // must be unique — suffix the id; name-typed search
                      // still matches.
                      value={`${stage.name} ${stage.id}`}
                      onSelect={() => {
                        save([...stageIds, stage.id]);
                        setAddOpen(false);
                      }}
                    >
                      <StageOption stage={stage} />
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </CardContent>
    </Card>
  );
}
