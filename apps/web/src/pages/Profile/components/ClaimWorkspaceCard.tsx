import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Profile > Claim a coach-prepared workspace (Phase 24, ENTRY-01): a bare
 * action into `/claim` — no code input here, no query string, no router
 * state, no permanent sidebar item (`/claim` is a transient action, per
 * 24-CONTEXT.md Area 2, not a destination).
 */
export function ClaimWorkspaceCard() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('profile.claimWorkspace.title')}</CardTitle>
        <CardDescription>{t('profile.claimWorkspace.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <Button type="button" variant="outline" onClick={() => navigate('/claim')}>
          {t('profile.claimWorkspace.action')}
        </Button>
      </CardContent>
    </Card>
  );
}
