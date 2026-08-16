import { useTranslation } from 'react-i18next';
import { getFighterById } from '@/data/sprites';
import { localizedFighterName } from '@/lib/fighterNames';
import type { EnrichmentCharacterAttribution } from '@/lib/enrichmentEvidence';
import { LiquipediaAttributionBadge } from './LiquipediaAttributionBadge';

/**
 * Phase 30.3 Gate 5 (web evidence-surfaces worker): the "X vs Y" character
 * evidence a Liquipedia observation may carry — the SUBJECT's character
 * first (never the opponent's, matching the `subjectFighterId`/
 * `opponentFighterId` naming the seat-orientation-proven witness commits
 * to). Renders one side at a time via `CharacterSide`:
 *
 *   - a resolved `*FighterId` renders the same sprite + localized name every
 *     other fighter-facing surface uses (`getFighterById` +
 *     `localizedFighterName`, `@/data/sprites` / `@/lib/fighterNames`);
 *   - an id-less side renders its `*Raw` source text UNCHANGED — the
 *     resolver's "flagged unmapped" state (an id that didn't resolve against
 *     `SpriteList`) is never silently dropped nor guessed into a sprite.
 *
 * Renders nothing when `characters` is `null`/`undefined` — every call site
 * is a `characters && <LiquipediaCharacterEvidence .../>` guard, mirroring
 * `LiquipediaAttributionBadge`'s own contract, so an un-enriched account (or
 * one whose evidence never proved seat orientation) renders byte-identically
 * to today.
 *
 * Ends with a `LiquipediaAttributionBadge` (variant="characters") so this
 * evidence is always clearly marked as Liquipedia-derived, never presented
 * as the row's own recorded (provider- or user-entered) character pick.
 */
function CharacterSide({ raw, fighterId }: { raw: string; fighterId: number | null | undefined }) {
  const { t } = useTranslation();
  const fighter = fighterId != null ? getFighterById(fighterId) : undefined;

  if (fighter) {
    return (
      <span className="inline-flex items-center gap-1">
        <img src={fighter.url} alt="" className="size-5 object-contain" />
        <span>{localizedFighterName(fighterId!, t)}</span>
      </span>
    );
  }

  // Raw text fallback (unmapped id, or no id at all) — untrusted third-party
  // source text, rendered through ordinary JSX text-node interpolation
  // (never dangerouslySetInnerHTML), matching every other raw-source render
  // in this module family.
  return <span data-testid="liquipedia-character-raw">{raw}</span>;
}

export function LiquipediaCharacterEvidence({
  characters,
}: {
  characters: EnrichmentCharacterAttribution | null | undefined;
}) {
  const { t } = useTranslation();

  if (characters == null) {
    return null;
  }

  return (
    <div
      data-testid="liquipedia-character-evidence"
      className="flex flex-col gap-0.5 text-xs text-muted-foreground"
    >
      <span className="inline-flex flex-wrap items-center gap-1">
        <CharacterSide raw={characters.subjectRaw} fighterId={characters.subjectFighterId} />
        <span>{t('matchups.vs')}</span>
        <CharacterSide raw={characters.opponentRaw} fighterId={characters.opponentFighterId} />
      </span>
      <LiquipediaAttributionBadge attribution={characters} variant="characters" />
    </div>
  );
}
