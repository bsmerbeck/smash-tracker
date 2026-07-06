import { StageList, type Stage } from '@smash-tracker/shared';

/**
 * parry.gg identifies stages by a `stage_slug` string, same shape of
 * problem as character slugs (see characters.ts) — normalize both sides
 * (strip accents/punctuation/case, matching startgg/stageMap.ts's
 * `normalize`/`resolveStageByName` transform, reused here rather than
 * duplicated) and match by name. `SLUG_OVERRIDES` exists for the day a
 * parry.gg stage slug is observed that genuinely doesn't normalize onto its
 * `StageList` name (e.g. an abbreviation rather than the full name) — every
 * stage this app has data for today (including accented names like
 * "Pokémon Stadium 2" and apostrophed ones like "Yoshi's Island") already
 * normalizes cleanly, so the table starts empty rather than carrying
 * speculative no-op entries.
 */
function normalizeSlug(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

const stagesByNormalizedSlug = new Map<string, Stage>();
for (const stage of StageList) {
  const key = normalizeSlug(stage.name);
  if (!stagesByNormalizedSlug.has(key)) {
    stagesByNormalizedSlug.set(key, stage);
  }
}

const stagesById = new Map<number, Stage>();
for (const stage of StageList) {
  if (!stagesById.has(stage.id)) {
    stagesById.set(stage.id, stage);
  }
}

/** Curated overrides for stage slugs that don't normalize onto their `StageList` name automatically — see the module doc comment. */
const SLUG_OVERRIDES: Readonly<Record<string, number>> = {};

/**
 * Resolves a parry.gg `stage_slug` to this app's stage, or null when
 * unmappable (unmapped stages import with the `{ id: 0, name: 'unknown' }`
 * sentinel, counted in the sync summary — same convention as start.gg's
 * `resolveStage`).
 */
export function resolveParryggStage(slug: string | null | undefined): Stage | null {
  if (!slug) {
    return null;
  }
  const key = normalizeSlug(slug);
  const overrideId = SLUG_OVERRIDES[key];
  if (overrideId !== undefined) {
    return stagesById.get(overrideId) ?? null;
  }
  return stagesByNormalizedSlug.get(key) ?? null;
}
