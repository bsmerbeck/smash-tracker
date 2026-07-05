import { useState } from 'react';
import { ExternalLink, Pencil } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { getFighterById } from '@/data/sprites';
import { stagesById } from '@/data/stages';
import { stageAbbreviation } from '@/components/StageOption';
import type { Match } from '@smash-tracker/shared';
import type { TournamentSet } from '../lib/setTimeline';
import { buildStartggUrl } from '../lib/startggLinks';
import { formatOpponentEventContext } from '../lib/ordinal';
import { cn } from '@/lib/utils';
import { formatTimestamp, vodDeepLink } from '@/lib/vod';
import { VodNotesDialog } from '@/components/vod/VodNotesDialog';

function GameChip({ match }: { match: Match }) {
  const stageId = match.map?.id ?? 0;
  const stage = stageId !== 0 ? stagesById.get(stageId) : undefined;
  const stageName = stage?.name ?? match.map?.name ?? 'unknown';
  const abbreviation = stage ? stageAbbreviation(stage.name) : '??';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded text-[10px] font-semibold',
            match.win ? 'bg-emerald-600 text-white' : 'bg-destructive text-white',
          )}
        >
          {abbreviation}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {stageName} — {match.win ? 'Win' : 'Loss'}
      </TooltipContent>
    </Tooltip>
  );
}

function OpponentTags({ opponentFighterIds }: { opponentFighterIds: number[] }) {
  return (
    <div className="flex items-center -space-x-1">
      {opponentFighterIds.map((id) => {
        const sprite = getFighterById(id);
        return sprite ? (
          <img
            key={id}
            src={sprite.url}
            alt={sprite.name}
            title={sprite.name}
            className="size-7 rounded-full border border-background object-contain"
          />
        ) : null;
      })}
    </div>
  );
}

/**
 * Clickable timestamp chips for a set's VOD notes (V7-E): each chip opens
 * the VOD at that moment via `vodDeepLink`. Renders nothing when the match
 * carrying the `vodUrl` has no `vodTimestamps`.
 */
function VodTimestampChips({ vodUrl, match }: { vodUrl: string; match: Match }) {
  const timestamps = match.vodTimestamps;
  if (!timestamps || timestamps.length === 0) {
    return null;
  }
  const sorted = [...timestamps].sort((a, b) => a.seconds - b.seconds);
  return (
    <div className="flex flex-wrap items-center gap-1">
      {sorted.map((stamp, index) => (
        <Tooltip key={`${stamp.seconds}-${index}`}>
          <TooltipTrigger asChild>
            <a
              href={vodDeepLink(vodUrl, stamp.seconds)}
              target="_blank"
              rel="noreferrer"
              className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground hover:bg-muted/70 hover:text-foreground"
            >
              {formatTimestamp(stamp.seconds)}
            </a>
          </TooltipTrigger>
          <TooltipContent>{stamp.note}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

/**
 * Outbound "Watch VOD" link plus timestamp-note chips for a set, shown when
 * any game in the set carries a `vodUrl` (start.gg's TO-curated
 * `Set.vodUrl`, duplicated across every game of the set during sync — see
 * `MatchRecord.vodUrl`), or when the player has manually attached one via
 * the edit affordance (V7-E). A pencil button always renders (using the
 * set's first game as the record to edit when no `vodUrl` exists yet) so a
 * VOD can be attached even for sets that never got one from start.gg.
 */
function VodLink({ set }: { set: TournamentSet }) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const vodMatch =
    set.games.map((g) => g.match).find((m) => m.vodUrl != null) ?? set.games[0]?.match;
  const vodUrl = vodMatch?.vodUrl;

  if (!vodMatch) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {vodUrl && (
        <>
          <a
            href={vodUrl}
            target="_blank"
            rel="noreferrer"
            aria-label={`Watch VOD for ${set.roundText ?? `Set ${set.setId}`}`}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            Watch VOD
            <ExternalLink className="size-3.5" />
          </a>
          <VodTimestampChips vodUrl={vodUrl} match={vodMatch} />
        </>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Edit VOD notes for ${set.roundText ?? `Set ${set.setId}`}`}
        onClick={() => setDialogOpen(true)}
      >
        <Pencil className="size-3.5" />
      </Button>
      {dialogOpen && (
        <VodNotesDialog match={vodMatch} open={dialogOpen} onOpenChange={setDialogOpen} />
      )}
    </div>
  );
}

function OpponentLabel({ set }: { set: TournamentSet }) {
  if (!set.opponentName) {
    return null;
  }
  const profileUrl = buildStartggUrl(set.opponentUserSlug);
  const context = formatOpponentEventContext({
    seed: set.opponentSeed,
    placement: set.opponentPlacement,
  });

  return (
    <span className="flex items-center gap-1 text-sm text-muted-foreground">
      <span className="inline-flex items-center gap-1">
        vs {set.opponentName}
        {profileUrl && (
          <a
            href={profileUrl}
            target="_blank"
            rel="noreferrer"
            aria-label={`View ${set.opponentName} on start.gg`}
            className="inline-flex text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="size-3.5" />
          </a>
        )}
      </span>
      {context && <span className="text-xs">({context})</span>}
    </span>
  );
}

function SetRow({ set }: { set: TournamentSet }) {
  const isLosersSide = set.bracketRound != null && set.bracketRound < 0;

  return (
    <li
      className={cn(
        'flex flex-wrap items-center justify-between gap-3 rounded-md border p-3',
        isLosersSide && 'border-l-4 border-l-destructive bg-destructive/5',
      )}
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="min-w-32 text-sm font-medium">{set.roundText ?? `Set ${set.setId}`}</span>
        <OpponentTags opponentFighterIds={set.opponentFighterIds} />
        <OpponentLabel set={set} />
        <div className="flex items-center gap-1">
          {set.games.map((g) => (
            <GameChip key={g.match.id} match={g.match} />
          ))}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <VodLink set={set} />
        <span className="text-sm text-muted-foreground">
          {set.gamesWon}-{set.gamesLost}
        </span>
        <Badge variant={set.won ? 'success' : 'destructive'}>{set.won ? 'Won' : 'Lost'}</Badge>
      </div>
    </li>
  );
}

/**
 * Chronological set-by-set breakdown of an entry's matches: round label
 * (falling back to "Set {id}" when start.gg's `roundText` hasn't synced
 * yet), a losers-side tint when `bracketRound` is negative, opponent
 * character tag(s), the opponent's human tag with an outbound start.gg
 * profile link (when `opponentUserSlug` synced) and a compact
 * "seed N · placed Nth" context label (when either is known), per-game stage
 * chips (color = win/loss, tooltip = stage name + result), an outbound
 * "Watch VOD" link (when any game in the set carries a `vodUrl`), and the
 * derived set score/result. Matches without a parseable set id render in a
 * separate list below.
 */
export function SetTimeline({
  sets,
  otherMatches,
}: {
  sets: TournamentSet[];
  otherMatches: Match[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Set Timeline</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {sets.length === 0 && otherMatches.length === 0 ? (
          <p className="text-sm text-muted-foreground">No matches recorded for this event yet.</p>
        ) : (
          <>
            {sets.length > 0 && (
              <ul className="flex flex-col gap-2" aria-label="Sets">
                {sets.map((set) => (
                  <SetRow key={set.setId} set={set} />
                ))}
              </ul>
            )}
            {otherMatches.length > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-medium text-muted-foreground">
                  Other matches during this event
                </h3>
                <ul className="flex flex-col gap-2" aria-label="Other matches during this event">
                  {otherMatches.map((match) => {
                    const opponentSprite = getFighterById(match.opponent_id);
                    return (
                      <li
                        key={match.id}
                        className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
                      >
                        <div className="flex items-center gap-3">
                          <span className="text-sm text-muted-foreground">
                            {new Date(match.time).toLocaleDateString()}
                          </span>
                          {opponentSprite && (
                            <img
                              src={opponentSprite.url}
                              alt={opponentSprite.name}
                              className="size-6 object-contain"
                            />
                          )}
                          <GameChip match={match} />
                        </div>
                        <Badge variant={match.win ? 'success' : 'destructive'}>
                          {match.win ? 'Win' : 'Loss'}
                        </Badge>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
