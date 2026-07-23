import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useFighters } from '@/hooks/useFighters';
import { useFighterNameResolver } from '@/hooks/useFighterName';
import { SpriteList } from '@/data/sprites';

function FighterSprites({ ids }: { ids: number[] }) {
  const { t } = useTranslation();
  const localizedName = useFighterNameResolver();
  const sprites = ids.map((id) => SpriteList.find((s) => s.id === id)).filter((s) => s != null);
  if (sprites.length === 0) {
    return <span className="text-sm text-muted-foreground">{t('profile.fighters.none')}</span>;
  }
  return (
    <div className="flex flex-wrap gap-2">
      {sprites.map((sprite) => (
        <div
          key={sprite.id}
          className="flex flex-col items-center gap-1"
          title={localizedName(sprite.id)}
        >
          <img src={sprite.url} alt={localizedName(sprite.id)} className="size-10 object-contain" />
          <span className="line-clamp-1 max-w-14 text-center text-xs">
            {localizedName(sprite.id)}
          </span>
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
  const { t } = useTranslation();
  const { data: fighters, isLoading } = useFighters();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('profile.fighters.title')}</CardTitle>
        <CardDescription>{t('profile.fighters.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">{t('profile.fighters.loading')}</p>
        ) : (
          <>
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium text-muted-foreground">
                {t('profile.fighters.primary')}
              </span>
              <FighterSprites ids={fighters?.primary ?? []} />
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium text-muted-foreground">
                {t('profile.fighters.secondary')}
              </span>
              <FighterSprites ids={fighters?.secondary ?? []} />
            </div>
          </>
        )}
        <Link
          to="/choose-primary"
          className="self-start text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
        >
          {t('profile.fighters.edit')}
        </Link>
      </CardContent>
    </Card>
  );
}
