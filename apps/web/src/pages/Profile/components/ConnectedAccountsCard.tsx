import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useStartggStatus } from '@/hooks/useStartgg';
import { useParryggStatus } from '@/hooks/useParrygg';

/**
 * Profile > Connected accounts: a read-only summary of the two start.gg /
 * parry.gg integrations, reusing their existing status hooks. Link/unlink
 * flows stay on the Integrations page — this card intentionally has no
 * mutations of its own.
 */
export function ConnectedAccountsCard() {
  const { t } = useTranslation();
  const startgg = useStartggStatus();
  const parrygg = useParryggStatus();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('profile.connected.title')}</CardTitle>
        <CardDescription>{t('profile.connected.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2 text-sm">
          <span className="font-medium">start.gg</span>
          {startgg.data?.linked ? (
            <span className="flex items-center gap-2">
              {startgg.data.gamerTag}
              <Badge variant="success">{t('profile.connected.linked')}</Badge>
            </span>
          ) : (
            <span className="text-muted-foreground">{t('profile.connected.notLinked')}</span>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 text-sm">
          <span className="font-medium">parry.gg</span>
          {parrygg.data?.linked ? (
            <span className="flex items-center gap-2">
              {parrygg.data.gamerTag}
              <Badge variant={parrygg.data.verified ? 'success' : 'outline'}>
                {parrygg.data.verified
                  ? t('integrations.parrygg.verified')
                  : t('integrations.parrygg.unverified')}
              </Badge>
            </span>
          ) : (
            <span className="text-muted-foreground">{t('profile.connected.notLinked')}</span>
          )}
        </div>
        <Link
          to="/settings/integrations"
          className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
        >
          {t('profile.connected.manage')}
        </Link>
      </CardContent>
    </Card>
  );
}
