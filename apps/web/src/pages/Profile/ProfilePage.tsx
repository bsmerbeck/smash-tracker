import { useAuth } from '@/hooks/useAuth';
import { useStartggStatus } from '@/hooks/useStartgg';
import { useParryggStatus } from '@/hooks/useParrygg';
import { AccountCard } from './components/AccountCard';
import { SecurityCard } from './components/SecurityCard';
import { ConnectedAccountsCard } from './components/ConnectedAccountsCard';
import { FightersCard } from './components/FightersCard';
import { FavoriteStagesCard } from './components/FavoriteStagesCard';
import { BillingCard } from './components/BillingCard';
import { YourDataCard } from './components/YourDataCard';

/**
 * `/profile` — V9: account management, appropriate to smash-tracker's four
 * coexisting sign-in methods (email/password, Google, start.gg custom-token,
 * parry.gg bio-code). Composed of independent cards so each can load/error
 * on its own; `ProtectedRoute` guarantees `user` is non-null here.
 *
 * Out of scope (see PR description for rationale): account deletion, email
 * change, sign-out-everywhere, avatar upload.
 */
export function ProfilePage() {
  const { user } = useAuth();
  const startgg = useStartggStatus();
  const parrygg = useParryggStatus();

  if (!user) {
    return null;
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Profile</h1>

      <AccountCard
        user={user}
        startggLinked={startgg.data?.linked ?? false}
        parryggLinked={parrygg.data?.linked ?? false}
        parryggGamerTag={parrygg.data?.gamerTag}
      />
      <SecurityCard user={user} />
      <ConnectedAccountsCard />
      <FightersCard />
      <FavoriteStagesCard />
      <BillingCard />
      <YourDataCard />
    </div>
  );
}
