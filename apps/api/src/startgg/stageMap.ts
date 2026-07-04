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

/**
 * start.gg's own numeric stage database id (`game.stage.id` from the GQL
 * API), mapped to this app's stage id. Verified stable/global via manual
 * probe queries (V6-W1b): the same stage consistently returned the same
 * numeric id across dozens of unrelated sets spanning different players,
 * events, and years (e.g. Battlefield was always 311, Pokémon Stadium 2
 * always 378 — whether queried from player 1802316's set history or from
 * Genesis 9's Ultimate Singles bracket). This is a curated table of every
 * start.gg stage id observed during that probe (built by cross-referencing
 * the observed name against `resolveStageByName`) rather than a generated
 * runtime lookup — start.gg does not expose a "list all stages with ids"
 * query, only ids attached to already-played games, so there is no
 * authoritative bulk source to generate this from at sync time.
 *
 * Deliberately NOT exhaustive: start.gg has far more stage entries than
 * this app's legal/common counterpick list, and only ids actually observed
 * in probe data are included here. `resolveStage` falls back to name
 * resolution for any id missing from this table, so an unmapped id never
 * causes a worse outcome than before this map existed.
 *
 * Note: id 513 (Hollow Bastion) was observed in probe data but has no
 * corresponding entry in this app's `StageList` (no Kingdom Hearts stage) —
 * the build loop below silently skips it, so it's a harmless no-op kept
 * here purely as a record of what start.gg returned.
 */
const STARTGG_STAGE_ID_TO_NAME: Readonly<Record<number, string>> = {
  311: 'Battlefield',
  328: 'Final Destination',
  348: 'Kalos Pokémon League',
  353: 'Lylat Cruise',
  378: 'Pokémon Stadium 2',
  385: 'Skyloft',
  387: 'Smashville',
  397: 'Town and City',
  484: 'Small Battlefield',
  513: 'Hollow Bastion',
};

const stagesByStartggId = new Map<number, Stage>();
for (const [startggId, name] of Object.entries(STARTGG_STAGE_ID_TO_NAME)) {
  const stage = resolveStageByName(name);
  if (stage) {
    stagesByStartggId.set(Number(startggId), stage);
  }
}

/**
 * Resolves a start.gg stage using its numeric `stage.id` first (stable,
 * accent/punctuation-proof), falling back to name resolution when the id
 * isn't in the curated table above (e.g. a stage this app hasn't observed
 * yet). Returns null when neither resolves.
 */
export function resolveStage(
  startggId: number | null | undefined,
  name: string | null | undefined,
): Stage | null {
  if (startggId != null) {
    const byId = stagesByStartggId.get(startggId);
    if (byId) {
      return byId;
    }
  }
  return name ? resolveStageByName(name) : null;
}
