import {
  LayoutDashboard,
  Plug,
  User,
  Users,
  UserSearch,
  Swords,
  LineChart,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  title: string;
  href: string;
  icon: LucideIcon;
}

/** Mirrors legacy/src/layouts/Main/components/Sidebar/Sidebar.js `pages`. */
export const navItems: NavItem[] = [
  { title: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { title: 'Choose Primary', href: '/choose-primary', icon: User },
  { title: 'Choose Secondary', href: '/choose-secondary', icon: Users },
  { title: 'Fighter Analysis', href: '/fighter-analysis', icon: UserSearch },
  { title: 'Matchups', href: '/matchups', icon: Swords },
  { title: 'Match Data', href: '/match-data', icon: LineChart },
  { title: 'Integrations', href: '/settings/integrations', icon: Plug },
];
