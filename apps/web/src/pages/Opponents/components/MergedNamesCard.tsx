import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useDeleteOpponentAlias } from '@/hooks/useOpponentAliases';

export interface MergedNamesCardProps {
  /** Canonical opponent name currently selected in the scouting report. */
  canonical: string;
  /** Alias names currently pointing at `canonical` (already filtered by the caller). */
  aliases: string[];
}

/**
 * "Merged names" management card: shown in the scouting report when at
 * least one alias currently resolves to the selected opponent. Each row
 * offers an "Un-merge" action (DELETE the alias), splitting that name back
 * out into its own separate scouting identity.
 */
export function MergedNamesCard({ canonical, aliases }: MergedNamesCardProps) {
  const { t } = useTranslation();
  const deleteAlias = useDeleteOpponentAlias();

  if (aliases.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('opponents.merged.title')}</CardTitle>
        <CardDescription>{t('opponents.merged.description', { name: canonical })}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-2" role="list" aria-label={t('opponents.merged.title')}>
          {aliases.map((alias) => (
            <li key={alias} className="flex items-center justify-between gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate">{alias}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={deleteAlias.isPending}
                onClick={() => deleteAlias.mutate(alias)}
              >
                {t('opponents.merged.unmerge')}
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
