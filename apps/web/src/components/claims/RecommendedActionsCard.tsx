import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Dumbbell, Swords, Video, type LucideIcon } from 'lucide-react';
import {
  MAX_RECOMMENDED_ACTIONS,
  resolveSubjectDisplayName,
  type ActionCandidate,
  type ClaimAtom,
  type RecommendedActionKind,
} from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SampleCue } from '@/components/EvidenceCues';
import { useFighterNameResolver } from '@/hooks/useFighterName';
import { useSubjectPath } from '@/hooks/useSubjectPath';
import { personalPathForActionTarget } from './actionDoors';

/**
 * Phase 39 (plan 39-11, RPT-09 / D-12, 39-UI-SPEC §C): the recommended-actions
 * block. At most `MAX_RECOMMENDED_ACTIONS` rows, drawn in the order received —
 * the engine ranks, this module never sorts. Each row is a kind icon, a
 * whole-sentence title, the citing claim's sample cue and exactly one door.
 *
 * This is the FREE module (D-11). It contains no brand treatment of any kind:
 * every door it draws is an outline button and no icon is brand-tinted. The
 * paid module (`PaidRecommendedActionsCard`) composes `RecommendedActionList`
 * and supplies its own door renderer; nothing in this file can produce the
 * paid look, so a free mount cannot render it.
 *
 * Doors are built from the candidate's axes by `personalPathForActionTarget`
 * and then passed through `useSubjectPath` — no route is spelled here.
 */

const KIND_ICON: Record<RecommendedActionKind, LucideIcon> = {
  matchup_practice: Swords,
  vod_review: Video,
  drill: Dumbbell,
};

/** One resolved door: where it goes and what it says. */
export interface ActionDoor {
  to: string;
  label: string;
}

/** A host-supplied door renderer. The free card never passes one; the default is an outline button. */
export type ActionDoorRenderer = (door: ActionDoor, rowIndex: number) => ReactNode;

function OutlineDoor({ door }: { door: ActionDoor }) {
  return (
    <Button asChild size="sm" variant="outline">
      <Link to={door.to}>{door.label}</Link>
    </Button>
  );
}

function numericParam(value: string | number | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function textParam(value: string | number | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/** The citing claim whose sample the caption shows: the first cited claim the host supplied. */
function citingClaim(
  action: ActionCandidate,
  claimsById: ReadonlyMap<string, ClaimAtom>,
): ClaimAtom | null {
  for (const claimId of action.claimIds) {
    const claim = claimsById.get(claimId);
    if (claim) {
      return claim;
    }
  }
  return null;
}

export interface RecommendedActionRowProps {
  action: ActionCandidate;
  /** The claim the action cites (its sample is the evidence caption); `null` renders no caption. */
  claim: ClaimAtom | null;
  rowIndex: number;
  renderDoor?: ActionDoorRenderer;
}

/** One action row: icon + title, the evidence caption, and one door (or none when the axes name nothing). */
export function RecommendedActionRow({
  action,
  claim,
  rowIndex,
  renderDoor,
}: RecommendedActionRowProps) {
  const { t } = useTranslation();
  const subjectPath = useSubjectPath();
  const fighterName = useFighterNameResolver();
  const Icon = KIND_ICON[action.kind];

  const unknown = t('common.unknown');
  const myFighterId = numericParam(action.titleParams.myFighterId);
  const opponentFighterId = numericParam(action.titleParams.opponentFighterId);
  const stageId = numericParam(action.titleParams.stageId);
  const opponentTag = textParam(action.titleParams.opponentTag);
  const opponentFighter = opponentFighterId !== null ? fighterName(opponentFighterId) : null;
  const title = t(action.titleKey, {
    myFighter: myFighterId !== null ? fighterName(myFighterId) : unknown,
    opponentFighter: opponentFighter ?? unknown,
    stage: stageId !== null ? resolveSubjectDisplayName('stage', stageId) : unknown,
    opponentTag: opponentTag ?? unknown,
    opponent: opponentTag ?? opponentFighter ?? unknown,
  });

  const personalPath = personalPathForActionTarget(action.target);
  const door: ActionDoor | null =
    personalPath === null ? null : { to: subjectPath(personalPath), label: t(action.doorKey) };

  return (
    <li
      className="flex flex-col gap-2 rounded-md border p-3"
      data-action-row=""
      data-action-kind={action.kind}
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 break-words">{title}</span>
      </div>
      {claim && claim.sample.confidenceTier != null && (
        <p className="text-xs text-muted-foreground" data-action-evidence="">
          <SampleCue sample={claim.sample} />
        </p>
      )}
      {door && (
        <div className="flex flex-wrap gap-2" data-action-door="">
          {renderDoor ? renderDoor(door, rowIndex) : <OutlineDoor door={door} />}
        </div>
      )}
    </li>
  );
}

export interface RecommendedActionListProps {
  /** Engine-ranked candidates, drawn in this order; anything past `MAX_RECOMMENDED_ACTIONS` is never drawn. */
  actions: readonly ActionCandidate[];
  /** The claims the candidates cite. */
  claims: readonly ClaimAtom[];
  renderDoor?: ActionDoorRenderer;
}

/** The capped row list, or the one-sentence empty state when there is nothing to recommend. */
export function RecommendedActionList({ actions, claims, renderDoor }: RecommendedActionListProps) {
  const { t } = useTranslation();
  const visible = actions.slice(0, MAX_RECOMMENDED_ACTIONS);
  if (visible.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('reports.actions.empty')}</p>;
  }
  const claimsById = new Map(claims.map((claim) => [claim.id as string, claim]));
  return (
    <ul className="flex flex-col gap-3">
      {visible.map((action, index) => (
        <RecommendedActionRow
          key={action.id}
          action={action}
          claim={citingClaim(action, claimsById)}
          rowIndex={index}
          renderDoor={renderDoor}
        />
      ))}
    </ul>
  );
}

export interface RecommendedActionsCardProps {
  actions: readonly ActionCandidate[];
  claims: readonly ClaimAtom[];
}

/** The FREE card (prep brief, both modes). */
export function RecommendedActionsCard({ actions, claims }: RecommendedActionsCardProps) {
  const { t } = useTranslation();
  return (
    <Card data-recommended-actions="free">
      <CardHeader>
        <CardTitle>{t('reports.actions.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <RecommendedActionList actions={actions} claims={claims} />
      </CardContent>
    </Card>
  );
}
