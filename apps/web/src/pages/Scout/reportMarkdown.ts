import {
  ABSTENTION_FLOOR_GAMES,
  resolveSubjectDisplayName,
  type ClaimAtomRecord,
  type ClaimPredicate,
  type ScoutReportRecord,
  type StoredScoutReport,
} from '@smash-tracker/shared';

/**
 * V7-B.1: "Download (.md)" support — a pure content builder for turning a
 * stored `ScoutReportRecord` into clean Markdown, consumed by
 * `ScoutAiReportCard`'s download button. Kept free of DOM/Blob concerns so
 * it's trivially unit-testable (same pattern as `evidencePacket.ts`'s
 * `packetToText`).
 *
 * `report.characterStrategy` is optional on the stored-record schema (V7-B.1
 * back-compat — see packages/shared/src/reports.ts): a pre-B.1 record simply
 * omits that section from the Markdown rather than rendering an empty one.
 *
 * Phase 39 (plan 39-09, review C2-H4): the export is the rendering a paying
 * user KEEPS, so it follows the same claim contract as the card. A
 * claims-era record (the stored `sections` map present) renders each section
 * as its connective followed by one line per claim in stored order, every
 * figure / sample / tier read from the claim object and never from prose. A
 * legacy record (no `sections`) renders exactly what it rendered before this
 * plan — `reportMarkdown.test.ts` pins it byte-for-byte. On BOTH paths a
 * heading whose body would be empty is suppressed (plan 39-06's projection
 * writes `confidenceNotes: ''` on every claims-era record, per D-03). The
 * export is English-only, like every heading in it; the claim lines mirror
 * the English `shared.evidence.*` / `reports.claimPredicate.*` copy.
 */

interface MarkdownSection {
  heading: string;
  body: string[];
}

/** Joins the title and every non-empty section exactly as the pre-Phase-39 builder laid them out. */
function assemble(title: string, sections: MarkdownSection[]): string {
  const blocks = sections
    .filter((section) => section.body.some((line) => line.trim().length > 0))
    .map((section) => [`## ${section.heading}`, ...section.body].join('\n'));
  return [title, '', blocks.join('\n\n')].join('\n');
}

function legacySections(report: StoredScoutReport): MarkdownSection[] {
  const sections: MarkdownSection[] = [
    { heading: 'Overview', body: [report.overview] },
    { heading: 'Game plan', body: report.gameplan.map((item) => `- ${item}`) },
  ];
  if (report.characterStrategy) {
    sections.push({
      heading: 'Character strategy',
      body: [
        ...(report.characterStrategy.picks.length > 0
          ? [`Picks: ${report.characterStrategy.picks.join(', ')}`, '']
          : []),
        report.characterStrategy.reasoning,
      ],
    });
  }
  sections.push(stageSection(report, report.stageStrategy.reasoning));
  if (report.headToHead) {
    sections.push({ heading: 'Head-to-head', body: [report.headToHead] });
  }
  sections.push({ heading: 'Watch for', body: report.watchFor.map((item) => `- ${item}`) });
  sections.push({ heading: 'Confidence notes', body: [report.confidenceNotes] });
  return sections;
}

function stageSection(report: StoredScoutReport, reasoning: string): MarkdownSection {
  const body: string[] = [];
  if (report.stageStrategy.bans.length > 0) {
    body.push(`Bans: ${report.stageStrategy.bans.join(', ')}`);
  }
  if (report.stageStrategy.picks.length > 0) {
    body.push(`Picks: ${report.stageStrategy.picks.join(', ')}`);
  }
  if (reasoning.trim().length > 0 || body.length > 0) {
    body.push('', reasoning);
  }
  return { heading: 'Stage strategy', body };
}

/** English mirror of `reports.claimPredicate.*` (en.json) — the export has no i18n. */
const PREDICATE_LABEL: Record<ClaimPredicate, string> = {
  stage_record: 'Stage record',
  stage_pick_rate: 'Stage pick rate',
  character_matchup_record: 'Matchup record',
  my_character_record: 'Character record',
  head_to_head_record: 'Head-to-head record',
  recent_form: 'Recent form',
  opponent_character_usage: 'Their character usage',
  matchup_advisor_pick: 'Suggested pick',
  vod_annotation: 'VOD moments',
  cohort_disclosure: 'Session mix',
};

/** 39.1-UI-SPEC §7.6's closed chip vocabulary (English `insights.kind.*`). */
const KIND_WORD: Record<ClaimAtomRecord['claimKind'], string> = {
  fact: 'Fact',
  inference: 'Trend',
  recommendation: 'Suggestion',
};

const COUNT = new Intl.NumberFormat('en');
const PERCENT = new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 0 });

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

/** The figure exactly as `ClaimAtomLine` formats it (English locale). */
function claimFigure(value: ClaimAtomRecord['value']): string | null {
  switch (value.kind) {
    case 'record': {
      const decided = value.wins + value.losses;
      const record = `${COUNT.format(value.wins)}–${COUNT.format(value.losses)}`;
      return decided >= ABSTENTION_FLOOR_GAMES
        ? `${record} · ${PERCENT.format(value.wins / decided)}`
        : record;
    }
    case 'rate': {
      const fraction = `${COUNT.format(value.numerator)}/${COUNT.format(value.denominator)}`;
      return value.denominator > 0
        ? `${PERCENT.format(value.numerator / value.denominator)} (${fraction})`
        : fraction;
    }
    case 'count':
      return COUNT.format(value.count);
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

function abstainedSentence(gamesNeeded: number): string {
  return `Not enough data yet — ${gamesNeeded} more ${gamesNeeded === 1 ? 'game' : 'games'} needed.`;
}

/** One claim as one Markdown bullet: kind, predicate, subject, then the app-rendered figure, sample and tier. */
function claimLine(claim: ClaimAtomRecord): string {
  const names = subjectNames(claim.subject);
  const lead = `[${KIND_WORD[claim.claimKind]}] ${PREDICATE_LABEL[claim.predicate]}${
    names.length > 0 ? `: ${names.join(' · ')}` : ''
  }`;
  const figure = claimFigure(claim.value);
  if (figure === null) {
    return `- ${lead} — ${abstainedSentence(claim.value.kind === 'abstained' ? claim.value.gamesNeeded : 0)}`;
  }
  const tier = claim.sample.confidenceTier;
  const games = claim.sample.eligibleDenominator;
  const cue = tier
    ? ` · ${COUNT.format(games)} ${games === 1 ? 'game' : 'games'} · ${tier} confidence`
    : '';
  return `- ${lead} — ${figure}${cue}`;
}

/** A claims-era section body: the connective (when it survived), then the surviving claims — or the abstention sentence when every claim abstained (the card's UI-SPEC E1 rule). */
function claimSectionBody(
  section: NonNullable<StoredScoutReport['sections']>[string] | undefined,
  claims: StoredScoutReport['claims'],
): string[] {
  if (!section) return [];
  const body: string[] = [];
  if (section.connective.trim().length > 0) {
    body.push(section.connective);
  }
  const resolved = section.claimIds
    .map((claimId) => claims?.[claimId])
    .filter((claim): claim is ClaimAtomRecord => claim !== undefined);
  const live = resolved.filter((claim) => claim.value.kind !== 'abstained');
  if (live.length > 0) {
    body.push(...live.map(claimLine));
  } else if (resolved.length > 0) {
    const gamesNeeded = Math.min(
      ...resolved.map((claim) => (claim.value.kind === 'abstained' ? claim.value.gamesNeeded : 0)),
    );
    body.push(abstainedSentence(gamesNeeded));
  }
  return body;
}

function claimsEraSections(report: StoredScoutReport): MarkdownSection[] {
  const sections = report.sections ?? {};
  return [
    { heading: 'Overview', body: claimSectionBody(sections.overview, report.claims) },
    { heading: 'Game plan', body: claimSectionBody(sections.gameplan, report.claims) },
    // Plan 39-06's projection fills `stageStrategy.reasoning` with the game-plan
    // connective; it is not restated here (the card does the same) — only the
    // engine-derived bans/picks.
    {
      heading: 'Stage strategy',
      body: stageSection(report, '').body.filter((line) => line.length > 0),
    },
    { heading: 'Watch for', body: claimSectionBody(sections.watchFor, report.claims) },
    { heading: 'Confidence notes', body: [report.confidenceNotes] },
  ];
}

export function reportToMarkdown(record: ScoutReportRecord): string {
  const { player, report, createdAt } = record;
  const generatedDate = new Date(createdAt).toLocaleDateString();
  const title = `# Scout Report: ${player.gamerTag} — ${generatedDate}`;
  return assemble(title, report.sections ? claimsEraSections(report) : legacySections(report));
}

/**
 * Filename for the downloaded Markdown file: `scout-report-<gamerTag>-<YYYY-MM-DD>.md`.
 * The gamer tag is slugified (lowercased, non-alphanumerics collapsed to a
 * single hyphen) so tags with spaces/punctuation still produce a safe
 * filename across operating systems.
 */
export function reportMarkdownFilename(record: ScoutReportRecord): string {
  const slug = record.player.gamerTag
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const isoDate = new Date(record.createdAt).toISOString().slice(0, 10);
  return `scout-report-${slug}-${isoDate}.md`;
}
