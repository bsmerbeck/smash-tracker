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
  { id: 2, name: 'Big Battlefield', url: '/assets/stages/2-big-battlefield.jpg' },
  { id: 3, name: 'Final Destination', url: '/assets/stages/2-final-destination.jpg' },
  { id: 4, name: 'New Donk City Hall', url: '/assets/stages/4-new-donk-city-hall.jpg' },
  { id: 5, name: 'Great Plateau Tower', url: '/assets/stages/5-great-plateau-tower.jpg' },
  { id: 6, name: 'Moray Towers', url: '/assets/stages/6-moray-towers.jpg' },
  { id: 7, name: "Dracula's Castle", url: '/assets/stages/7-draculas-castle.jpg' },
  { id: 8, name: 'Mementos', url: '/assets/stages/8-mementos.jpg' },
  { id: 9, name: "Yggdrasil's Altar", url: '/assets/stages/9-yggdrasils-altar.jpg' },
  { id: 10, name: 'Spiral Mountain', url: '/assets/stages/10-spiral-mountain.jpg' },
  { id: 11, name: "Peach's Castle", url: '/assets/stages/11-peachs-castle.jpg' },
  { id: 12, name: 'Mushroom Kingdom', url: '/assets/stages/12-mushroom-kingdom.jpg' },
  { id: 13, name: "Princess Peach's Castle", url: '/assets/stages/13-princess-peachs-castle.jpg' },
  { id: 14, name: 'Rainbow Cruise', url: '/assets/stages/14-rainbow-cruise.jpg' },
  { id: 15, name: 'Mushroom Kingdom II', url: '/assets/stages/15-mushroom-kingdom-ii.jpg' },
  { id: 16, name: 'Delfino Plaza', url: '/assets/stages/16-delfino-plaza.jpg' },
  { id: 17, name: "Luigi's Mansion", url: '/assets/stages/17-luigis-mansion.jpg' },
  { id: 18, name: 'Mushroomy Kingdom', url: '/assets/stages/18-mushroomy-kingdom.jpg' },
  { id: 19, name: 'Figure-8 Circuit', url: '/assets/stages/19-figure-8-circuit.jpg' },
  { id: 20, name: 'Mario Bros.', url: '/assets/stages/20-mario-bros.jpg' },
  { id: 21, name: '3D Land', url: '/assets/stages/21-3d-land.jpg' },
  { id: 22, name: 'Golden Plains', url: '/assets/stages/22-golden-plains.jpg' },
  { id: 23, name: 'Paper Mario', url: '/assets/stages/23-paper-mario.jpg' },
  { id: 24, name: 'Mushroom Kingdom U', url: '/assets/stages/24-mushroom-kingdom-u.jpg' },
  { id: 25, name: 'Mario Galaxy', url: '/assets/stages/25-mario-galaxy.jpg' },
  { id: 26, name: 'Mario Circuit', url: '/assets/stages/26-mario-circuit.jpg' },
  { id: 27, name: 'Super Mario Maker', url: '/assets/stages/27-super-mario-maker.jpg' },
  { id: 28, name: 'Kongo Jungle', url: '/assets/stages/28-kongo-jungle.jpg' },
  { id: 29, name: 'Kongo Falls', url: '/assets/stages/29-kongo-falls.jpg' },
  { id: 30, name: 'Jungle Japes', url: '/assets/stages/30-jungle-japes.jpg' },
  { id: 31, name: '75m', url: '/assets/stages/31-75m.jpg' },
  { id: 32, name: 'Super Happy Tree', url: '/assets/stages/32-super-happy-tree.jpg' },
  { id: 33, name: "Yoshi's Island (Melee)", url: '/assets/stages/33-yoshis-island-melee.jpg' },
  { id: 34, name: "Yoshi's Story", url: '/assets/stages/19-yoshis-story.jpg' },
  { id: 35, name: 'Yoshi’s Island', url: '/assets/stages/35-yoshis-island.jpg' },
  { id: 36, name: 'Hyrule Castle', url: '/assets/stages/36-hyrule-castle.jpg' },
  { id: 37, name: 'Great Bay', url: '/assets/stages/37-great-bay.jpg' },
  { id: 38, name: 'Temple', url: '/assets/stages/38-temple.jpg' },
  { id: 39, name: 'Bridge of Eldin', url: '/assets/stages/39-bridge-of-eldin.jpg' },
  { id: 40, name: 'Pirate Ship', url: '/assets/stages/40-pirate-ship.jpg' },
  { id: 41, name: 'Gerudo Valley', url: '/assets/stages/41-gerudo-valley.jpg' },
  { id: 42, name: 'Spirit Train', url: '/assets/stages/42-spirit-train.jpg' },
  { id: 43, name: 'Skyloft', url: '/assets/stages/43-skyloft.jpg' },
  { id: 44, name: 'Brinstar', url: '/assets/stages/44-brinstar.jpg' },
  { id: 45, name: 'Brinstar Depths', url: '/assets/stages/45-brinstar-depths.jpg' },
  { id: 46, name: 'Norfair', url: '/assets/stages/46-norfair.jpg' },
  { id: 47, name: 'Frigate Orpheon', url: '/assets/stages/47-frigate-orpheon.jpg' },
  { id: 48, name: 'Dream Land', url: '/assets/stages/48-dream-land.jpg' },
  { id: 49, name: 'Fountain of Dreams', url: '/assets/stages/49-fountain-of-dreams.jpg' },
  { id: 50, name: 'Green Greens', url: '/assets/stages/50-green-greens.jpg' },
  { id: 51, name: 'Halberd', url: '/assets/stages/51-halberd.jpg' },
  { id: 52, name: 'Dream Land GB', url: '/assets/stages/52-dream-land-gb.jpg' },
  {
    id: 53,
    name: 'The Great Cave Offensive',
    url: '/assets/stages/53-the-great-cave-offensive.jpg',
  },
  { id: 54, name: 'Corneria', url: '/assets/stages/54-corneria.jpg' },
  { id: 55, name: 'Venom', url: '/assets/stages/55-venom.jpg' },
  { id: 56, name: 'Lylat Cruise', url: '/assets/stages/39-lylat-cruise.jpg' },
  { id: 57, name: 'Saffron City', url: '/assets/stages/57-saffron-city.jpg' },
  { id: 58, name: 'Pokémon Stadium', url: '/assets/stages/58-pokemon-stadium.jpg' },
  { id: 59, name: 'Pokémon Stadium 2', url: '/assets/stages/40-pokemon-stadium-2.jpg' },
  { id: 60, name: 'Spear Pillar', url: '/assets/stages/60-spear-pillar.jpg' },
  { id: 61, name: 'Unova Pokémon League', url: '/assets/stages/62-unova-pokemon-league.jpg' },
  { id: 62, name: 'Prism Tower', url: '/assets/stages/62-prism-tower.jpg' },
  { id: 63, name: 'Kalos Pokémon League', url: '/assets/stages/79-kalos-pokemon-league.jpg' },
  { id: 64, name: 'Big Blue', url: '/assets/stages/64-big-blue.jpg' },
  { id: 65, name: 'Port Town Aero Dive', url: '/assets/stages/65-port-town-aero-dive.jpg' },
  { id: 66, name: 'Mute City SNES', url: '/assets/stages/66-mute-city-snes.jpg' },
  { id: 67, name: 'Onett', url: '/assets/stages/67-onett.jpg' },
  { id: 68, name: 'Fourside', url: '/assets/stages/68-fourside.jpg' },
  { id: 69, name: 'New Pork City', url: '/assets/stages/69-new-pork-city.jpg' },
  { id: 70, name: 'Magicant', url: '/assets/stages/70-magicant.jpg' },
  { id: 71, name: 'Summit', url: '/assets/stages/71-summit.jpg' },
  { id: 72, name: 'Castle Siege', url: '/assets/stages/72-castle-siege.jpg' },
  { id: 73, name: 'Arena Ferox', url: '/assets/stages/73-arena-ferox.jpg' },
  { id: 74, name: 'Coliseum', url: '/assets/stages/74-coliseum.jpg' },
  { id: 75, name: 'Flat Zone X', url: '/assets/stages/75-flat-zone-x.jpg' },
  { id: 76, name: 'Skyworld', url: '/assets/stages/76-skyworld.jpg' },
  { id: 77, name: 'Reset Bomb Forest', url: '/assets/stages/77-reset-bomb-forest.jpg' },
  { id: 78, name: "Palutena's Temple", url: '/assets/stages/78-palutenas-temple.jpg' },
  { id: 79, name: 'WarioWare  Inc.', url: '/assets/stages/79-warioware-inc.jpg' },
  { id: 80, name: 'Gamer', url: '/assets/stages/80-gamer.jpg' },
  { id: 81, name: 'Distant Planet', url: '/assets/stages/81-distant-planet.jpg' },
  { id: 82, name: 'Garden of Hope', url: '/assets/stages/82-garden-of-hope.jpg' },
  { id: 83, name: 'Smashville', url: '/assets/stages/44-smashville.jpg' },
  { id: 84, name: 'Tortimer Island', url: '/assets/stages/84-tortimer-island.jpg' },
  { id: 85, name: 'Town and City', url: '/assets/stages/85-town-and-city.jpg' },
  { id: 86, name: 'Boxing Ring', url: '/assets/stages/86-boxing-ring.jpg' },
  { id: 87, name: 'Wii Fit Studio', url: '/assets/stages/87-wii-fit-studio.jpg' },
  { id: 88, name: 'Gaur Plain', url: '/assets/stages/88-gaur-plain.jpg' },
  { id: 89, name: 'Duck Hunt', url: '/assets/stages/89-duck-hunt.jpg' },
  { id: 90, name: 'Shadow Moses Island', url: '/assets/stages/90-shadow-moses-island.jpg' },
  { id: 91, name: 'Green Hill Zone', url: '/assets/stages/91-green-hill-zone.jpg' },
  { id: 92, name: 'Windy Hill Zone', url: '/assets/stages/92-windy-hill-zone.jpg' },
  { id: 93, name: 'Wily Castle', url: '/assets/stages/93-wily-castle.jpg' },
  { id: 94, name: 'Pac-Land', url: '/assets/stages/94-pac-land.jpg' },
  { id: 95, name: 'Suzaku Castle', url: '/assets/stages/95-suzaku-castle.jpg' },
  { id: 96, name: 'Midgar', url: '/assets/stages/96-midgar.jpg' },
  { id: 97, name: 'Umbra Clock Tower', url: '/assets/stages/97-umbra-clock-tower.jpg' },
  { id: 98, name: 'Hanenbow', url: '/assets/stages/98-hanenbow.jpg' },
  { id: 99, name: 'PictoChat 2', url: '/assets/stages/99-pictochat-2.jpg' },
  { id: 100, name: 'Balloon Fight', url: '/assets/stages/100-balloon-fight.jpg' },
  { id: 101, name: 'Living Room', url: '/assets/stages/101-living-room.jpg' },
  { id: 102, name: 'Find Mii', url: '/assets/stages/102-find-mii.jpg' },
  { id: 103, name: 'Tomodachi Life', url: '/assets/stages/103-tomodachi-life.jpg' },
  { id: 104, name: 'Wrecking Crew', url: '/assets/stages/104-wrecking-crew.jpg' },
  { id: 105, name: 'Pilotwings', url: '/assets/stages/105-pilotwings.jpg' },
  { id: 106, name: 'Wuhu Island', url: '/assets/stages/106-wuhu-island.jpg' },
  { id: 107, name: 'Momentos', url: '/assets/stages/107-momentos.jpg' },
  { id: 108, name: "Yggdrasil's Altar", url: '/assets/stages/108-yggdrasils-altar.jpg' },
  { id: 109, name: 'Spiral Mountain', url: '/assets/stages/109-spiral-mountain.jpg' },
  {
    id: 110,
    name: 'King of Fighters Stadium',
    url: '/assets/stages/110-king-of-fighters-stadium.jpg',
  },
  { id: 111, name: 'Garreg Mach Monastery', url: '/assets/stages/111-garreg-mach-monastery.jpg' },
  { id: 112, name: 'Spring Stadium', url: '/assets/stages/112-spring-stadium.jpg' },
  { id: 113, name: 'Small Battlefield', url: '/assets/stages/113-small-battlefield.jpg' },
  { id: 114, name: 'Minecraft World', url: '/assets/stages/114-minecraft-world.jpg' },
  { id: 115, name: 'Northern Cave', url: '/assets/stages/115-northern-cave.jpg' },
  { id: 116, name: 'Cloud Sea of Alrest', url: '/assets/stages/116-cloud-sea-of-alrest.jpg' },
  { id: 114, name: 'Minecraft World', url: '/assets/stages/114-minecraft-world.jpg' },
  { id: 115, name: 'Northern Cave', url: '/assets/stages/115-northern-cave.jpg' },
  { id: 116, name: 'Cloud Sea of Alrest', url: '/assets/stages/116-cloud-sea-of-alrest.jpg' },
  { id: 117, name: 'Mishima Dojo', url: '/assets/stages/117-mishima-dojo.jpg' },
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
