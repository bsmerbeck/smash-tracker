import {
  LayoutDashboard,
  Plug,
  User,
  Users,
  UserSearch,
  Swords,
  Target,
  Search,
  LineChart,
  Medal,
  TrendingUp,
  Trophy,
  Sparkles,
  Gauge,
  Video,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  /** i18n key under `nav.*` (V15) — render with `t(titleKey)`; the sidebar and RouteTitles share these so labels and document titles can't drift. */
  titleKey: string;
  href: string;
  icon: LucideIcon;
}

/** Mirrors legacy/src/layouts/Main/components/Sidebar/Sidebar.js `pages`. */
export const navItems: NavItem[] = [
  { titleKey: 'nav.dashboard', href: '/dashboard', icon: LayoutDashboard },
  { titleKey: 'nav.choosePrimary', href: '/choose-primary', icon: User },
  { titleKey: 'nav.chooseSecondary', href: '/choose-secondary', icon: Users },
  { titleKey: 'nav.fighterAnalysis', href: '/fighter-analysis', icon: UserSearch },
  { titleKey: 'nav.matchups', href: '/matchups', icon: Swords },
  { titleKey: 'nav.scouting', href: '/opponents', icon: Target },
  { titleKey: 'nav.scoutAPlayer', href: '/scout', icon: Search },
  { titleKey: 'nav.aiReports', href: '/reports', icon: Sparkles },
  { titleKey: 'nav.matchData', href: '/match-data', icon: LineChart },
  { titleKey: 'nav.vodManager', href: '/vod', icon: Video },
  { titleKey: 'nav.tournaments', href: '/tournaments', icon: Medal },
  { titleKey: 'nav.trends', href: '/trends', icon: TrendingUp },
  { titleKey: 'nav.gsp', href: '/gsp', icon: Gauge },
  { titleKey: 'nav.groups', href: '/groups', icon: Trophy },
  { titleKey: 'nav.integrations', href: '/settings/integrations', icon: Plug },
];
