/**
 * Stage reference data, ported verbatim from
 * legacy/src/components/Stages/StageList.js — including its quirks:
 *
 * - Ids 114, 115, 116 (Minecraft World, Northern Cave, Cloud Sea of Alrest)
 *   each appear twice in the source array. This is NOT fixed here: production
 *   match data may reference either occurrence via `map.id`, and legacy
 *   array-scan lookups (`StageList.find/filter(s => s.id === x)`) always
 *   resolved to the first match, so `stagesById` below preserves that
 *   first-occurrence-wins behavior.
 * - Ids 1000 / 1001 ("(Gen. Battlefield)", "(Gen. Final Destination)") are
 *   synthetic "generic" stage entries with no image, also preserved verbatim.
 * - `id: 0` is NOT present in this list; it is the "no selection" sentinel
 *   used by match records' `map` field (see packages/shared's
 *   matchStageSchema) and is handled separately by consumers, not looked up
 *   here.
 */
import type { Stage } from './stage.js';

export const StageList: Stage[] = [
  { id: 1, name: 'Battlefield', url: '/assets/stages/1-battlefield.jpg' },
  { id: 2, name: 'Big Battlefield', url: '' },
  { id: 3, name: 'Final Destination', url: '/assets/stages/2-final-destination.jpg' },
  { id: 4, name: 'New Donk City Hall', url: '' },
  { id: 5, name: 'Great Plateau Tower', url: '' },
  { id: 6, name: 'Moray Towers', url: '' },
  { id: 7, name: "Dracula's Castle", url: '' },
  { id: 8, name: 'Mementos', url: '' },
  { id: 9, name: "Yggdrasil's Altar", url: '' },
  { id: 10, name: 'Spiral Mountain', url: '' },
  { id: 11, name: "Peach's Castle", url: '' },
  { id: 12, name: 'Mushroom Kingdom', url: '' },
  { id: 13, name: "Princess Peach's Castle", url: '' },
  { id: 14, name: 'Rainbow Cruise', url: '' },
  { id: 15, name: 'Mushroom Kingdom II', url: '' },
  { id: 16, name: 'Delfino Plaza', url: '' },
  { id: 17, name: "Luigi's Mansion", url: '' },
  { id: 18, name: 'Mushroomy Kingdom', url: '' },
  { id: 19, name: 'Figure-8 Circuit', url: '' },
  { id: 20, name: 'Mario Bros.', url: '' },
  { id: 21, name: '3D Land', url: '' },
  { id: 22, name: 'Golden Plains', url: '' },
  { id: 23, name: 'Paper Mario', url: '' },
  { id: 24, name: 'Mushroom Kingdom U', url: '' },
  { id: 25, name: 'Mario Galaxy', url: '' },
  { id: 26, name: 'Mario Circuit', url: '' },
  { id: 27, name: 'Super Mario Maker', url: '' },
  { id: 28, name: 'Kongo Jungle', url: '' },
  { id: 29, name: 'Kongo Falls', url: '' },
  { id: 30, name: 'Jungle Japes', url: '' },
  { id: 31, name: '75m', url: '' },
  { id: 32, name: 'Super Happy Tree', url: '' },
  { id: 33, name: "Yoshi's Island (Melee)", url: '' },
  { id: 34, name: "Yoshi's Story", url: '/assets/stages/19-yoshis-story.jpg' },
  { id: 35, name: 'Yoshi’s Island', url: '' },
  { id: 36, name: 'Hyrule Castle', url: '' },
  { id: 37, name: 'Great Bay', url: '' },
  { id: 38, name: 'Temple', url: '' },
  { id: 39, name: 'Bridge of Eldin', url: '' },
  { id: 40, name: 'Pirate Ship', url: '' },
  { id: 41, name: 'Gerudo Valley', url: '' },
  { id: 42, name: 'Spirit Train', url: '' },
  { id: 43, name: 'Skyloft', url: '' },
  { id: 44, name: 'Brinstar', url: '' },
  { id: 45, name: 'Brinstar Depths', url: '' },
  { id: 46, name: 'Norfair', url: '' },
  { id: 47, name: 'Frigate Orpheon', url: '' },
  { id: 48, name: 'Dream Land', url: '' },
  { id: 49, name: 'Fountain of Dreams', url: '' },
  { id: 50, name: 'Green Greens', url: '' },
  { id: 51, name: 'Halberd', url: '' },
  { id: 52, name: 'Dream Land GB', url: '' },
  { id: 53, name: 'The Great Cave Offensive', url: '' },
  { id: 54, name: 'Corneria', url: '' },
  { id: 55, name: 'Venom', url: '' },
  { id: 56, name: 'Lylat Cruise', url: '/assets/stages/39-lylat-cruise.jpg' },
  { id: 57, name: 'Saffron City', url: '' },
  { id: 58, name: 'Pokémon Stadium', url: '' },
  { id: 59, name: 'Pokémon Stadium 2', url: '/assets/stages/40-pokemon-stadium-2.jpg' },
  { id: 60, name: 'Spear Pillar', url: '' },
  { id: 61, name: 'Unova Pokémon League', url: '' },
  { id: 62, name: 'Prism Tower', url: '' },
  { id: 63, name: 'Kalos Pokémon League', url: '/assets/stages/79-kalos-pokemon-league.jpg' },
  { id: 64, name: 'Big Blue', url: '' },
  { id: 65, name: 'Port Town Aero Dive', url: '' },
  { id: 66, name: 'Mute City SNES', url: '' },
  { id: 67, name: 'Onett', url: '' },
  { id: 68, name: 'Fourside', url: '' },
  { id: 69, name: 'New Pork City', url: '' },
  { id: 70, name: 'Magicant', url: '' },
  { id: 71, name: 'Summit', url: '' },
  { id: 72, name: 'Castle Siege', url: '' },
  { id: 73, name: 'Arena Ferox', url: '' },
  { id: 74, name: 'Coliseum', url: '' },
  { id: 75, name: 'Flat Zone X', url: '' },
  { id: 76, name: 'Skyworld', url: '' },
  { id: 77, name: 'Reset Bomb Forest', url: '' },
  { id: 78, name: "Palutena's Temple", url: '' },
  { id: 79, name: 'WarioWare  Inc.', url: '' },
  { id: 80, name: 'Gamer', url: '' },
  { id: 81, name: 'Distant Planet', url: '' },
  { id: 82, name: 'Garden of Hope', url: '' },
  { id: 83, name: 'Smashville', url: '/assets/stages/44-smashville.jpg' },
  { id: 84, name: 'Tortimer Island', url: '' },
  { id: 85, name: 'Town and City', url: '/assets/stages/85-town-and-city.jpg' },
  { id: 86, name: 'Boxing Ring', url: '' },
  { id: 87, name: 'Wii Fit Studio', url: '' },
  { id: 88, name: 'Gaur Plain', url: '' },
  { id: 89, name: 'Duck Hunt', url: '' },
  { id: 90, name: 'Shadow Moses Island', url: '' },
  { id: 91, name: 'Green Hill Zone', url: '' },
  { id: 92, name: 'Windy Hill Zone', url: '' },
  { id: 93, name: 'Wily Castle', url: '' },
  { id: 94, name: 'Pac-Land', url: '' },
  { id: 95, name: 'Suzaku Castle', url: '' },
  { id: 96, name: 'Midgar', url: '' },
  { id: 97, name: 'Umbra Clock Tower', url: '' },
  { id: 98, name: 'Hanenbow', url: '' },
  { id: 99, name: 'PictoChat 2', url: '' },
  { id: 100, name: 'Balloon Fight', url: '' },
  { id: 101, name: 'Living Room', url: '' },
  { id: 102, name: 'Find Mii', url: '' },
  { id: 103, name: 'Tomodachi Life', url: '' },
  { id: 104, name: 'Wrecking Crew', url: '' },
  { id: 105, name: 'Pilotwings', url: '' },
  { id: 106, name: 'Wuhu Island', url: '' },
  { id: 107, name: 'Momentos', url: '' },
  { id: 108, name: "Yggdrasil's Altar", url: '' },
  { id: 109, name: 'Spiral Mountain', url: '' },
  { id: 110, name: 'King of Fighters Stadium', url: '' },
  { id: 111, name: 'Garreg Mach Monastery', url: '' },
  { id: 112, name: 'Spring Stadium', url: '' },
  { id: 113, name: 'Small Battlefield', url: '/assets/stages/113-small-battlefield.jpg' },
  { id: 114, name: 'Minecraft World', url: '' },
  { id: 115, name: 'Northern Cave', url: '' },
  { id: 116, name: 'Cloud Sea of Alrest', url: '' },
  { id: 114, name: 'Minecraft World', url: '' },
  { id: 115, name: 'Northern Cave', url: '' },
  { id: 116, name: 'Cloud Sea of Alrest', url: '' },
  { id: 117, name: 'Mishima Dojo', url: '' },
  { id: 1000, name: '(Gen. Battlefield)', url: '' },
  { id: 1001, name: '(Gen. Final Destination)', url: '' },
];

/**
 * Lookup map by id. Built with a plain `for` loop (not `Object.fromEntries`
 * / `Map` constructor from entries) so that for the known-duplicate ids
 * (114-116) the FIRST occurrence in `StageList` wins, matching legacy's
 * `Array.find`/`Array.filter(...)[0]` lookup behavior.
 */
export const stagesById = new Map<number, Stage>();
for (const stage of StageList) {
  if (!stagesById.has(stage.id)) {
    stagesById.set(stage.id, stage);
  }
}

/** The sentinel used for "no stage selected" in match records (create flow). */
export const NO_SELECTION_STAGE = { id: 0, name: 'no selection' } as const;

/** The sentinel legacy defensively coalesces to when reading older records missing `map` entirely. */
export const UNKNOWN_STAGE = { id: 0, name: 'unknown' } as const;

/** Looks up a stage by id. Returns undefined if not found (e.g. id 0 or bad data). */
export function getStageById(id: number): Stage | undefined {
  return stagesById.get(id);
}
