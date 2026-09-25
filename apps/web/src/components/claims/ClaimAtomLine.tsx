import { useTranslation } from 'react-i18next';
import {
  ABSTENTION_FLOOR_GAMES,
  resolveSubjectDisplayName,
  type ClaimAtomRecord,
  type ClaimPredicate,
  type SampleMeta,
} from '@smash-tracker/shared';
import { SampleCue } from '@/components/EvidenceCues';
import { ClaimChip, type ClaimChipKind } from '@/components/analytics/ClaimChip';
import { resolveClaimSection, type ResolvedClaimSection } from './claimSection';
import type { StoredClaimMap, StoredClaimSection } from './claimSection';

/**
 * Phase 39 (plan 39-09, RPT-06, D-01/D-03): one structured claim, rendered
 * per 39-UI-SPEC §A.
 *
 * VERDICT line — the claim-kind marker, then the host-supplied prose (the
 * model's lint-passed connective) or, when the host supplies none, the
 * claim's own predicate label.
 * EVIDENCE line — 100% app-rendered from the stored claim object: the
 * subject's licensed names, the figure (record / rate / count / entity,
 * formatted through `Intl.NumberFormat` in the active language) and the
 * confidence sentence through the shared `SampleCue`. Nothing on this line
 * is ever read out of the prose — a claim whose prose says a different number
 * still shows the claim's number here.
 *
 * The figure carries `print:text-black`: the print block (`.print-packet-root`)
 * prints on white with inherited black ink, and the dark theme's light
 * `text-foreground` would otherwise print the one load-bearing value
 * near-invisible.
 *
 * Presentational only: no uid, no query, no subject-type branch. Mounted by
 * free surfaces (plan 39-11) as well as paid ones, so it never carries the
 * paid brand treatment. Prose renders as React text (escaped), never markup.
 *
 * Claim-kind marker: Phase 39.1's `ClaimChip` IS on the tree, so this is the
 * UI-SPEC's primitive branch — 39.1-UI-SPEC §7.6 maps `ClaimKind`
 * `fact | inference | recommendation` onto the chip's closed three-word
 * vocabulary `Fact | Trend | Suggestion`, with the chip's own label keys.
 * The shipped `shared.evidence.type.*` sentence is the marker's accessible
 * label and hover title.
 */

/** 39.1-UI-SPEC §7.6: `ClaimKind` -> `ClaimChipKind`. Duplicated per this codebase's small-helper-duplication convention (see `MatchDataRail.tsx`). */
function claimChipKindFor(kind: ClaimAtomRecord['claimKind']): ClaimChipKind {
  if (kind === 'inference') return 'trend';
  if (kind === 'recommendation') return 'suggestion';
  return 'fact';
}

/** The predicate's short label key (`reports.claimPredicate.*`) — shown on the verdict line only when the host passes no prose. */
const PREDICATE_LABEL_KEY: Record<ClaimPredicate, string> = {
  stage_record: 'reports.claimPredicate.stageRecord',
  stage_pick_rate: 'reports.claimPredicate.stagePickRate',
  character_matchup_record: 'reports.claimPredicate.characterMatchupRecord',
  my_character_record: 'reports.claimPredicate.myCharacterRecord',
  head_to_head_record: 'reports.claimPredicate.headToHeadRecord',
  recent_form: 'reports.claimPredicate.recentForm',
  opponent_character_usage: 'reports.claimPredicate.opponentCharacterUsage',
  matchup_advisor_pick: 'reports.claimPredicate.matchupAdvisorPick',
  vod_annotation: 'reports.claimPredicate.vodAnnotation',
  cohort_disclosure: 'reports.claimPredicate.cohortDisclosure',
};

const EN_DASH = '–';
const MIDDOT = '·';

/** The subject's licensed names in the validator's fixed axis order: my fighter, their fighter, stage, opponent tag. */
function subjectNames(subject: ClaimAtomRecord['subject']): string[] {
  if (!subject) return [];
  const names: string[] = [];
  if (subject.myFighterId != null)
    names.push(resolveSubjectDisplayName('fighter', subject.myFighterId));
  if (subject.opponentFighterId != null) {
    names.push(resolveSubjectDisplayName('fighter', subject.opponentFighterId));
  }
  if (subject.stageId != null) names.push(resolveSubjectDisplayName('stage', subject.stageId));
  if (subject.opponentTag) names.push(subject.opponentTag);
  return names;
}

/** The claim's figure, formatted by the app — `null` for an abstained claim (it renders the abstention sentence instead). */
function formatFigure(value: ClaimAtomRecord['value'], locale: string): string | null {
  const count = new Intl.NumberFormat(locale);
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 });
  switch (value.kind) {
    case 'record': {
      const decided = value.wins + value.losses;
      const record = `${count.format(value.wins)}${EN_DASH}${count.format(value.losses)}`;
      return decided >= ABSTENTION_FLOOR_GAMES
        ? `${record} ${MIDDOT} ${percent.format(value.wins / decided)}`
        : record;
    }
    case 'rate': {
      const fraction = `${count.format(value.numerator)}/${count.format(value.denominator)}`;
      return value.denominator > 0
        ? `${percent.format(value.numerator / value.denominator)} (${fraction})`
        : fraction;
    }
    case 'count':
      return count.format(value.count);
    case 'entity': {
      const id = Number(value.entityId);
      if (
        (value.entityKind === 'fighter' || value.entityKind === 'stage') &&
        Number.isInteger(id)
      ) {
        return resolveSubjectDisplayName(value.entityKind, id);
      }
      return value.entityId;
    }
    case 'abstained':
      return null;
  }
}

/** The stored sample, in the in-memory `SampleMeta` shape `SampleCue` reads (RTDB-stripped nullish members restored to `null`). */
function toSampleMeta(sample: ClaimAtomRecord['sample']): SampleMeta {
  return {
    ...sample,
    dateRange: sample.dateRange ?? null,
    confidenceTier: sample.confidenceTier ?? null,
  } as SampleMeta;
}

export interface ClaimAtomLineProps {
  /** One stored claim (plan 39-06's `claimAtomSchema`). */
  claim: ClaimAtomRecord;
  /** Host-supplied connective prose for this claim; omitted or `''` renders the predicate label instead. */
  prose?: string | null;
}

export function ClaimAtomLine({ claim, prose }: ClaimAtomLineProps) {
  const { t, i18n } = useTranslation();
  const chipKind = claimChipKindFor(claim.claimKind);
  const typeSentence = t(`shared.evidence.type.${claim.claimKind}`);
  const verdict =
    prose && prose.trim().length > 0 ? prose : t(PREDICATE_LABEL_KEY[claim.predicate]);
  const names = subjectNames(claim.subject);
  const figure = formatFigure(claim.value, i18n.language);
  const sample = toSampleMeta(claim.sample);

  return (
    <div className="flex flex-col gap-1" data-claim-id={claim.id}>
      <div className="flex flex-wrap items-center gap-1 text-sm">
        <span role="img" aria-label={typeSentence} title={typeSentence} className="inline-flex">
          <ClaimChip kind={chipKind} label={t(`insights.kind.${chipKind}`)} />
        </span>
        <span>{verdict}</span>
      </div>
      <p className="text-xs text-muted-foreground" data-claim-evidence="">
        {names.length > 0 && <span>{`${names.join(` ${MIDDOT} `)} — `}</span>}
        {figure === null ? (
          <span>
            {t('shared.evidence.abstained', {
              count: claim.value.kind === 'abstained' ? claim.value.gamesNeeded : 0,
            })}
          </span>
        ) : (
          <>
            <span
              className="font-medium tabular-nums text-foreground print:text-black"
              data-claim-figure=""
            >
              {figure}
            </span>
            {sample.confidenceTier != null && (
              <>
                <span>{` ${MIDDOT} `}</span>
                <SampleCue sample={sample} />
              </>
            )}
          </>
        )}
      </p>
    </div>
  );
}

export interface ClaimSectionBodyProps {
  /** The stored section (`{ claimIds, connective }`). */
  section: StoredClaimSection | null | undefined;
  /** The record's stored claim map. */
  claims: StoredClaimMap | null | undefined;
  /** Pre-resolved section — a host that already resolved it (to decide its heading) passes it to avoid resolving twice. */
  resolved?: ResolvedClaimSection;
}

/**
 * One claim-anchored section body (no heading — the host owns it and
 * suppresses it on `empty`): the connective once as the section lead, then
 * one `ClaimAtomLine` per surviving claim in stored order — or the shipped
 * abstention sentence in place of the list when every claim abstained.
 * 1..N claims render identically; an empty list element is never rendered.
 */
export function ClaimSectionBody({ section, claims, resolved }: ClaimSectionBodyProps) {
  const { t } = useTranslation();
  const body = resolved ?? resolveClaimSection(section, claims);
  if (body.kind === 'empty') {
    return null;
  }
  return (
    <div className="flex flex-col gap-2">
      {body.connective && <p className="text-sm">{body.connective}</p>}
      {body.kind === 'claims' && (
        <ul className="flex flex-col gap-3">
          {body.claims.map((claim) => (
            <li key={claim.id}>
              <ClaimAtomLine claim={claim} />
            </li>
          ))}
        </ul>
      )}
      {body.kind === 'abstained' && (
        <p className="text-sm text-muted-foreground">
          {t('shared.evidence.abstained', { count: body.gamesNeeded })}
        </p>
      )}
    </div>
  );
}
