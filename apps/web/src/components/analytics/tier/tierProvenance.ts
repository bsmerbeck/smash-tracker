import { useTranslation } from 'react-i18next';
import type { TierResolution } from '@smash-tracker/shared';

/** One whole-sentence translation key plus the values it interpolates (no concatenation, UI-SPEC §9). */
export interface TierProvenanceMessage {
  key: string;
  values: Record<string, string | number>;
}

/** The estimated sentence for `entrants`: `count` selects `_one`/`_other`, `entrants` is pre-formatted for `locale`. */
export function estimatedProvenanceMessage(
  entrants: number,
  locale: string,
): TierProvenanceMessage {
  return {
    key: 'tiers.provenance.estimated',
    values: { count: entrants, entrants: new Intl.NumberFormat(locale).format(entrants) },
  };
}

/**
 * The sentence naming HOW a tier was established (UI-SPEC §7.2), as ONE
 * whole-sentence key per (basis, reason). Pure: the entrant figure is
 * pre-formatted with the caller's locale so each locale groups its own way,
 * and the raw entrant count travels as `count` so i18next selects
 * `_one`/`_other`. Returns `null` for a recorded tier whose source has no
 * sentence: only `liquipedia` has one, and nothing in Phase 39.2 produces a
 * recorded tier (Phase 42 does).
 */
export function tierProvenanceKey(
  resolution: TierResolution,
  locale: string,
): TierProvenanceMessage | null {
  if (resolution.basis === 'manual') {
    return resolution.tier === 'unknown'
      ? { key: 'tiers.unknownReason.manual', values: {} }
      : { key: 'tiers.provenance.manual', values: {} };
  }
  if (resolution.basis === 'recorded') {
    return resolution.source === 'liquipedia'
      ? { key: 'tiers.provenance.recorded.liquipedia', values: {} }
      : null;
  }
  if (resolution.basis === 'estimated') {
    return estimatedProvenanceMessage(resolution.entrants ?? 0, locale);
  }
  switch (resolution.reason) {
    case 'online':
      return { key: 'tiers.unknownReason.online', values: {} };
    case 'sideEvent':
      return { key: 'tiers.unknownReason.sideEvent', values: {} };
    case 'noEntrants':
      return { key: 'tiers.unknownReason.noEntrants', values: {} };
    case 'settingUnknown':
      return { key: 'tiers.setting.unknown', values: {} };
    case 'manual':
      return { key: 'tiers.unknownReason.manual', values: {} };
    default:
      return null;
  }
}

/** The localised provenance sentence for a resolution, or `null` when it has none. */
export function useTierProvenanceText(resolution: TierResolution): string | null {
  const { t, i18n } = useTranslation();
  const message = tierProvenanceKey(resolution, i18n.language);
  return message ? t(message.key, message.values) : null;
}
