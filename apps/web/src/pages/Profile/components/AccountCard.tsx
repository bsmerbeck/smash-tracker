import { useState, type FormEvent } from 'react';
import type { User as FirebaseUser } from 'firebase/auth';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/hooks/useAuth';
import { getAuthErrorMessage } from '@/lib/firebaseErrors';
import { describeSignInMethods, formatMemberSince } from '../accountInfo';

const DISPLAY_NAME_MAX_LENGTH = 50;

function initialFromEmail(email: string | null | undefined): string {
  return email ? email.charAt(0).toUpperCase() : '?';
}

/**
 * Profile > Account: avatar initial, identity line, "Member since", a
 * derived sign-in-methods summary, and the display-name editor. parry.gg
 * accounts have no email at all (uid `parrygg-{parryUserId}`), so the
 * identity line falls back to their linked parry.gg gamer tag when one is
 * known.
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
        <DisplayNameForm user={user} />
      </CardContent>
    </Card>
  );
}

/**
 * The display name is what VOD share links attach when the owner enables
 * "Show your display name" (SHARE-02) — email/password accounts start
 * without one, so this is the only place they can set it.
 */
function DisplayNameForm({ user }: { user: FirebaseUser }) {
  const { t } = useTranslation();
  const { updateDisplayName } = useAuth();
  const [name, setName] = useState(user.displayName ?? '');
  const [saving, setSaving] = useState(false);

  const trimmed = name.trim();
  const dirty = trimmed !== (user.displayName ?? '');

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      // An emptied field clears the name entirely (updateProfile treats
      // null as "remove"), which re-disables the share dialog's name toggle.
      await updateDisplayName(trimmed === '' ? null : trimmed);
      toast.success(t('profile.account.displayNameSaved'));
    } catch (error) {
      toast.error(getAuthErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSave} className="flex flex-col gap-1.5">
      <Label htmlFor="profile-display-name">{t('profile.account.displayNameLabel')}</Label>
      <div className="flex items-center gap-2">
        <Input
          id="profile-display-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t('profile.account.displayNamePlaceholder')}
          maxLength={DISPLAY_NAME_MAX_LENGTH}
        />
        <Button type="submit" disabled={!dirty || saving}>
          {t('common.save')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t('profile.account.displayNameHelper')}</p>
    </form>
  );
}
