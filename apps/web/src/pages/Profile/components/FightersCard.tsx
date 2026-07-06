import { Link } from 'react-router';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useFighters } from '@/hooks/useFighters';
import { SpriteList } from '@/data/sprites';

function FighterSprites({ ids }: { ids: number[] }) {
  const sprites = ids.map((id) => SpriteList.find((s) => s.id === id)).filter((s) => s != null);
  if (sprites.length === 0) {
    return <span className="text-sm text-muted-foreground">None selected</span>;
  }
  return (
    <div className="flex flex-wrap gap-2">
      {sprites.map((sprite) => (
        <div key={sprite.id} className="flex flex-col items-center gap-1" title={sprite.name}>
          <img src={sprite.url} alt={sprite.name} className="size-10 object-contain" />
          <span className="line-clamp-1 max-w-14 text-center text-xs">{sprite.name}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Profile > Fighters: read-only summary of the caller's primary/secondary
 * fighter selections, rendered as the same sprite tiles CharacterSelect
 * uses. "Edit fighters" links to /choose-primary — the entry point for
 * changing either half of the selection.
 */
export function FightersCard() {
  const { data: fighters, isLoading } = useFighters();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Fighters</CardTitle>
        <CardDescription>Your primary and secondary Smash Ultimate fighters.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading your fighters...</p>
        ) : (
          <>
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium text-muted-foreground">Primary</span>
              <FighterSprites ids={fighters?.primary ?? []} />
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium text-muted-foreground">Secondary</span>
              <FighterSprites ids={fighters?.secondary ?? []} />
            </div>
          </>
        )}
        <Link
          to="/choose-primary"
          className="self-start text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
        >
          Edit fighters
        </Link>
      </CardContent>
    </Card>
  );
}
