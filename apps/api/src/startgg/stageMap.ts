import { StageList, type Stage } from '@smash-tracker/shared';

/**
 * start.gg reports stages by display name (e.g. "Pokémon Stadium 2"); this
 * maps them onto the app's stage list by accent/punctuation-insensitive
 * name. First occurrence wins for the stage list's duplicate-id quirk
 * (verbatim legacy data — ids 114-116 appear twice).
 */
function normalize(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

const stagesByNormalizedName = new Map<string, Stage>();
for (const stage of StageList) {
  const key = normalize(stage.name);
  if (!stagesByNormalizedName.has(key)) {
    stagesByNormalizedName.set(key, stage);
  }
}

/** Resolves a start.gg stage name to the app's stage, or null when unknown. */
export function resolveStageByName(name: string): Stage | null {
  return stagesByNormalizedName.get(normalize(name)) ?? null;
}
