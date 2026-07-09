import type { User as FirebaseUser } from 'firebase/auth';
import { useTranslation } from 'react-i18next';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { describeSignInMethods, formatMemberSince } from '../accountInfo';

function initialFromEmail(email: string | null | undefined): string {
  return email ? email.charAt(0).toUpperCase() : '?';
}

/**
 * Profile > Account: avatar initial, identity line, "Member since", and a
 * derived sign-in-methods summary. parry.gg accounts have no email at all
 * (uid `parrygg-{parryUserId}`), so the identity line falls back to their
 * linked parry.gg gamer tag when one is known.
 */
export function AccountCard({
  user,
  startggLinked,
  parryggLinked,
  parryggGamerTag,
}: {
  user: FirebaseUser;
  startggLinked: boolean;
  parryggLinked: boolean;
  parryggGamerTag: string | undefined;
}) {
  const { t, i18n } = useTranslation();
  const memberSince = formatMemberSince(user.metadata.creationTime, i18n.language);
  const signInMethods = describeSignInMethods(user, { startggLinked, parryggLinked }, t);
  const identity = user.email
    ? user.email
    : parryggGamerTag
      ? t('profile.account.parryggNoEmailLinked', { tag: parryggGamerTag })
      : t('profile.account.parryggNoEmail');

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('profile.account.title')}</CardTitle>
        <CardDescription>{t('profile.account.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <Avatar className="size-12">
            <AvatarFallback className="text-base">{initialFromEmail(user.email)}</AvatarFallback>
          </Avatar>
          <div className="flex flex-col">
            <span className="font-medium">{identity}</span>
            {memberSince && (
              <span className="text-sm text-muted-foreground">
                {t('profile.account.memberSince', { date: memberSince })}
              </span>
            )}
          </div>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">{t('profile.account.signInMethods')}</dt>
          <dd className="font-medium">{signInMethods}</dd>
        </dl>
      </CardContent>
    </Card>
  );
}
