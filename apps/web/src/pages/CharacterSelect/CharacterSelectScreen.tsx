import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useFighters } from '@/hooks/useFighters';
import { useSaveFighters } from '@/hooks/useSaveFighters';
import { useFighterNameResolver } from '@/hooks/useFighterName';
import { matchesFighterQuery } from '@/lib/fighterNames';
import { SpriteList } from '@/data/sprites';
import { cn } from '@/lib/utils';

interface SaveDestination {
  label: string;
  href: string;
}

interface CharacterSelectScreenProps {
  /** Which half of the selection this screen edits. */
  slot: 'primary' | 'secondary';
  heading: string;
  description: string;
  /** Where each save button navigates after a successful save. */
  destinations: SaveDestination[];
}

/**
 * Shared implementation behind /choose-primary and /choose-secondary.
 * Ports legacy/src/screens/CharacterSelect/{PrimarySelect,SecondarySelect}
 * behavior: pick from a grid of all 85 fighters, toggle selection by
 * clicking a tile again, filter by typing a name prefix, and exclude
 * whichever fighters are already claimed by the OTHER slot (legacy filtered
 * the "available" grid down when the other selection existed).
 */
export function CharacterSelectScreen({
  slot,
  heading,
  description,
  destinations,
}: CharacterSelectScreenProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: fighters, isLoading } = useFighters();
  const saveFighters = useSaveFighters();
  const localizedName = useFighterNameResolver();

  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [filter, setFilter] = useState('');
  // Tracks whether `selectedIds` has been seeded from the server response
  // yet. Set during render (not in an effect) the first time `fighters`
  // loads, following React's documented "adjusting state when a prop
  // changes" pattern — mirrors legacy's one-time "firstLoad" hydration from
  // Redux state without introducing a render-after-commit effect.
  const [seededFrom, setSeededFrom] = useState<typeof fighters>(undefined);

  const currentSelection = slot === 'primary' ? fighters?.primary : fighters?.secondary;
  const otherSelection = slot === 'primary' ? fighters?.secondary : fighters?.primary;

  if (fighters && seededFrom !== fighters) {
    setSeededFrom(fighters);
    setSelectedIds(currentSelection ?? []);
  }

  const otherIds = useMemo(() => new Set(otherSelection ?? []), [otherSelection]);

  const selectedSprites = useMemo(
    () => selectedIds.map((id) => SpriteList.find((s) => s.id === id)).filter((s) => s != null),
    [selectedIds],
  );

  const availableSprites = useMemo(() => {
    return SpriteList.filter((s) => !otherIds.has(s.id))
      .filter((s) => !selectedIds.includes(s.id))
      .filter((s) => matchesFighterQuery(filter, localizedName(s.id), s.name));
  }, [filter, otherIds, selectedIds, localizedName]);

  function toggleSprite(id: number) {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]));
  }

  async function handleSave(destination: SaveDestination) {
    const input =
      slot === 'primary'
        ? { primary: selectedIds, secondary: fighters?.secondary ?? [] }
        : { primary: fighters?.primary ?? [], secondary: selectedIds };
    try {
      await saveFighters.mutateAsync(input);
      toast.success(t('characterSelect.saved'));
      navigate(destination.href);
    } catch {
      toast.error(t('characterSelect.saveFailed'));
    }
  }

  if (isLoading) {
    return <div className="text-muted-foreground">{t('characterSelect.loading')}</div>;
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{heading}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
      </div>

      <div className="flex flex-col gap-3 rounded-lg border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-medium">
            {t('characterSelect.selected', { count: selectedSprites.length })}
          </h2>
        </div>
        {selectedSprites.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('characterSelect.emptySelected')}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {selectedSprites.map((sprite) => (
              <SpriteTile
                key={sprite.id}
                sprite={sprite}
                name={localizedName(sprite.id)}
                selected
                onClick={() => toggleSprite(sprite.id)}
              />
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 pt-2">
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t('characterSelect.filterPlaceholder')}
            className="max-w-xs"
          />
          <div className="flex flex-1 flex-wrap justify-end gap-2">
            {destinations.map((destination) => (
              <Button
                key={destination.href}
                onClick={() => handleSave(destination)}
                disabled={selectedIds.length === 0 || saveFighters.isPending}
              >
                {destination.label}
              </Button>
            ))}
          </div>
        </div>
      </div>

      <div
        className="grid grid-cols-4 gap-2 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10"
        data-testid="available-sprite-grid"
      >
        {availableSprites.map((sprite) => (
          <SpriteTile
            key={sprite.id}
            sprite={sprite}
            name={localizedName(sprite.id)}
            onClick={() => toggleSprite(sprite.id)}
          />
        ))}
      </div>
    </div>
  );
}

function SpriteTile({
  sprite,
  name,
  selected = false,
  onClick,
}: {
  sprite: { id: number; url: string };
  /** Localized display name (resolved by the caller via `useFighterNameResolver`). */
  name: string;
  selected?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      title={name}
      className={cn(
        'flex flex-col items-center gap-1 rounded-md border p-2 text-center transition-colors hover:bg-accent',
        selected && 'border-primary ring-2 ring-primary ring-offset-2 ring-offset-background',
      )}
    >
      <img src={sprite.url} alt={name} className="size-12 object-contain" />
      <span className="line-clamp-1 text-xs">{name}</span>
    </button>
  );
}
