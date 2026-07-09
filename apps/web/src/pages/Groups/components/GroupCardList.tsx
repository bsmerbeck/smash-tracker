import { useTranslation } from 'react-i18next';
import { Users } from 'lucide-react';
import type { GroupRecord } from '@smash-tracker/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/** "My groups" cards — selecting one shows its leaderboard. */
export function GroupCardList({
  groups,
  selectedGroupId,
  onSelect,
}: {
  groups: GroupRecord[];
  selectedGroupId: string | null;
  onSelect: (groupId: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {groups.map((group) => (
        <button
          key={group.id}
          type="button"
          onClick={() => onSelect(group.id)}
          aria-pressed={group.id === selectedGroupId}
          className="text-left"
        >
          <Card
            className={cn(
              'transition-colors hover:border-primary/50',
              group.id === selectedGroupId && 'border-primary',
            )}
          >
            <CardHeader>
              <CardTitle className="flex items-center justify-between gap-2">
                <span className="truncate">{group.name}</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Users className="size-4" />
              {t('groups.members', { count: group.memberCount })}
            </CardContent>
          </Card>
        </button>
      ))}
    </div>
  );
}
