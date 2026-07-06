import { NavLink } from 'react-router';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import { navItems } from './nav';
import ssbuTrainingGroundsLogo from '@/assets/SSBU_TG-03.png';

function initialFromEmail(email: string | null | undefined): string {
  return email ? email.charAt(0).toUpperCase() : '?';
}

/**
 * Sidebar contents shared by the persistent desktop sidebar and the mobile
 * Sheet drawer. Mirrors legacy's Sidebar > Profile + SidebarNav structure.
 */
export function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const { user } = useAuth();

  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <div className="flex flex-col items-center gap-2 py-2">
        <Avatar className="size-14">
          <AvatarFallback className="text-lg">{initialFromEmail(user?.email)}</AvatarFallback>
        </Avatar>
        <p className="max-w-full truncate text-sm font-medium" title={user?.email ?? ''}>
          {user?.email ?? 'Signed out'}
        </p>
      </div>

      <Separator />

      <nav className="flex flex-1 flex-col gap-1" aria-label="Main navigation">
        {navItems.map((item) => (
          <NavLink
            key={item.href}
            to={item.href}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                'hover:bg-accent hover:text-accent-foreground',
                isActive ? 'bg-accent text-accent-foreground' : 'text-muted-foreground',
              )
            }
          >
            <item.icon className="size-4 shrink-0" />
            {item.title}
          </NavLink>
        ))}
      </nav>

      <Separator />

      <a
        href="https://discord.gg/9TN8RFZ"
        target="_blank"
        rel="noreferrer"
        className="flex items-center gap-3 rounded-md border px-3 py-2 text-sm font-medium transition-colors hover:bg-accent"
      >
        <img
          src={ssbuTrainingGroundsLogo}
          alt="SSBU Training Grounds"
          className="size-8 shrink-0 rounded-full"
        />
        Training Grounds
      </a>

      {/* Donorbox blue (#41a2d8) kept from the legacy button so it reads as
          the familiar Donate control rather than another nav item. */}
      <a
        href="https://donorbox.org/support-smash-tracker"
        target="_blank"
        rel="noreferrer"
        className="flex items-center justify-center gap-3 rounded-md bg-[#41a2d8] px-3 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
      >
        <img
          src="https://donorbox.org/images/white_logo.svg"
          alt=""
          role="presentation"
          className="h-4 shrink-0"
        />
        Donate
      </a>
    </div>
  );
}
