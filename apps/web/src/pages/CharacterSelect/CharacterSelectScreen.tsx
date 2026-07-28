import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useFighters } from '@/hooks/useFighters';
import { useFighterSlotSelection } from '@/hooks/useFighterSlotSelection';
import { useSaveFighters } from '@/hooks/useSaveFighters';
import { useFighterNameResolver } from '@/hooks/useFighterName';
import { matchesFighterQuery, sortFightersByLocalizedName } from '@/lib/fighterNames';
import { SpriteList } from '@/data/sprites';
import { cn } from '@/lib/utils';

interface SaveDestination {
  label: string;
  href: string;
}

// Stable reference for the "not yet known" rendering fallback below, so
// `?? EMPTY_IDS` doesn't create a new array (and re-trigger memoized
// derivations) on every render while `selectedIds` is `undefined`.
const EMPTY_IDS: number[] = [];

/**
 * Combined-page integration point (260726-r4) — see the doc comments on
 * `ClientFightersPage`/`OwnerFightersPage`. When present, the PAGE owns
 * this slot's on-page selection AND the sibling slot's, so a save from
 * EITHER panel always sends a full, coherent `{primary, secondary}` pair
 * reflecting both slots' current on-page state — never a stale/partial
 * read-modify-write against the replace-semantics `PUT`. The page also
 * decides what happens after a successful save (stay put, don't navigate),
 * since a combined page needs to let the user set the other slot next.
 */
interface CombinedSlotController {
  /** This slot's current on-page selection, or `undefined` until this
   * subject's server value has actually been observed. */
  selectedIds: number[] | undefined;
  onSelectedIdsChange: (ids: number[]) => void;
  /** The sibling slot's current, actually-known on-page selection (may
   * include the sibling panel's own unsaved edits). `undefined` blocks
   * saving here — it is never coerced to `[]`. */
  otherSlotIds: number[] | undefined;
  /** Runs instead of navigating after a successful save. */
  onSaved: () => void;
}

interface CharacterSelectScreenProps {
  /** Which half of the selection this screen edits. */
  slot: 'primary' | 'secondary';
  heading: string;
  description: string;
  /** Where each save button navigates after a successful save. Ignored
   * (no navigation happens) when `combined` is provided. */
  destinations: SaveDestination[];
  /** Combined-page mode — see `CombinedSlotController`. Omit for the
   * standalone `/choose-primary` / `/choose-secondary` onboarding flow,
   * which keeps navigating after a successful save. */
  combined?: CombinedSlotController;
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
  combined,
}: CharacterSelectScreenProps) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { data: fighters, isLoading, isError } = useFighters();
  const saveFighters = useSaveFighters();
  const localizedName = useFighterNameResolver();

  const [filter, setFilter] = useState('');

  // Standalone (uncontrolled) selection state — unused while `combined`
  // drives selection, but always called so hook order never depends on
  // whether `combined` is provided (260726-r4).
  const [internalSelectedIds, setInternalSelectedIds] = useFighterSlotSelection(fighters, slot);

  const otherKey = slot === 'primary' ? 'secondary' : 'primary';
  // Only trust a server-observed value here — never `?? []`. `fighters` is
  // `undefined` while unresolved/errored, and that must block saving, not
  // be silently treated as an empty other slot (260726-r4).
  const standaloneOtherIds = fighters ? fighters[otherKey] : undefined;

  const selectedIds = combined ? combined.selectedIds : internalSelectedIds;
  const otherSlotIds = combined ? combined.otherSlotIds : standaloneOtherIds;
  const setSelectedIds = combined ? combined.onSelectedIdsChange : setInternalSelectedIds;

  // Rendering-only fallback to `[]` — safe here because it never reaches
  // the save payload; `handleSave` below gates on the real (possibly
  // `undefined`) `selectedIds`/`otherSlotIds`.
  const displaySelectedIds = selectedIds ?? EMPTY_IDS;

  const otherIds = useMemo(() => new Set(otherSlotIds ?? []), [otherSlotIds]);

  const selectedSprites = useMemo(
    () =>
      displaySelectedIds.map((id) => SpriteList.find((s) => s.id === id)).filter((s) => s != null),
    [displaySelectedIds],
  );

  const availableSprites = useMemo(() => {
    const filtered = SpriteList.filter((s) => !otherIds.has(s.id))
      .filter((s) => !displaySelectedIds.includes(s.id))
      .filter((s) => matchesFighterQuery(filter, localizedName(s.id), s.name));
    // 260725-Q1: alphabetized by localized name, not roster/fighter-number
    // order — the same sort every other fighter-selection surface uses.
    return sortFightersByLocalizedName(filtered, localizedName, i18n.resolvedLanguage);
  }, [filter, otherIds, displaySelectedIds, localizedName, i18n.resolvedLanguage]);

  function toggleSprite(id: number) {
    const next = displaySelectedIds.includes(id)
      ? displaySelectedIds.filter((s) => s !== id)
      : [...displaySelectedIds, id];
    setSelectedIds(next);
  }

  // 260726-r4 (P0 data-loss fix): a save may only send a slot value the
  // client has actually observed from the server — unknown is never
  // coerced to empty. Blocked while `fighters` is loading/errored (both
  // slots resolve to `undefined` in that case) or, in combined mode, while
  // the sibling slot hasn't seeded yet.
  const canSave = selectedIds !== undefined && otherSlotIds !== undefined && !isError;

  async function handleSave(destination: SaveDestination) {
    if (!canSave || selectedIds === undefined || otherSlotIds === undefined) return;
    const input =
      slot === 'primary'
        ? { primary: selectedIds, secondary: otherSlotIds }
        : { primary: otherSlotIds, secondary: selectedIds };
    try {
      await saveFighters.mutateAsync(input);
      toast.success(t('characterSelect.saved'));
      if (combined) {
        combined.onSaved();
      } else {
        navigate(destination.href);
      }
    } catch {
      toast.error(t('characterSelect.saveFailed'));
    }
  }

  if (isLoading) {
    return <div className="text-muted-foreground">{t('characterSelect.loading')}</div>;
  }

  if (isError && fighters == null) {
    return <div className="text-sm text-destructive">{t('characterSelect.loadError')}</div>;
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
                disabled={displaySelectedIds.length === 0 || saveFighters.isPending || !canSave}
              >
                {destination.label}
              </Button>
            ))}
          </div>
        </div>
        {isError && <p className="text-sm text-destructive">{t('characterSelect.loadError')}</p>}
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
