/**
 * ASSET-01/02: acquires official stage promotional art from smashbros.com
 * and writes it into `public/assets/stages/{id}-{kebab-slug}.jpg` at the
 * locked 750x421 JPEG convention already used by the 10 pre-existing images.
 *
 * Data source: 19-RESEARCH.md "Appendix A: Complete Stage -> Source Image URL
 * Map" (transcribed verbatim below as STAGE_ART_MAP — a fixed, code-reviewed
 * literal, never derived from user input/env/runtime config; see the phase
 * threat model T-19-01). Re-running this script re-downloads (and
 * re-resizes) every mapped stage; already-committed stages in PRESENT_IDS are
 * left untouched.
 *
 * Run: `pnpm --filter @smash-tracker/web acquire:stages`
 *   (equivalent: `node apps/web/scripts/acquire-stage-art.mjs` from repo root,
 *   or `node scripts/acquire-stage-art.mjs` from apps/web/)
 *
 * Resize tooling: macOS `sips` (preinstalled, no new dependency, per
 * 19-CONTEXT.md's "no heavyweight new deps if avoidable" direction). Cross
 * platform (Linux/CI) equivalent, if this script is ever ported off macOS:
 *   magick <file> -resize 750x421! <file>
 * (the `!` forces the exact 750x421 dimensions instead of preserving aspect
 * ratio, matching what `sips -z 421 750` does here).
 */
import { writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(webRoot, 'public/assets/stages');

const BASE = 'https://www.smashbros.com/assets_v2/img/stage';

/** The 10 stages already committed in a prior session — left byte-for-byte
 * as-is (stale-but-valid filenames from an older site snapshot). */
export const PRESENT_IDS = new Set([1, 3, 34, 56, 59, 61, 63, 83, 85, 113]);

/**
 * Transcribed verbatim from 19-RESEARCH.md Appendix A (117 real stage rows;
 * the two NO-MATCH synthetic sentinels 1000/1001 are excluded — they get no
 * art by design). `resize: true` rows are 1280x720 DLC-carousel sources
 * (`stage_addition_imgN.jpg`); `resize: false` rows are already 750x421.
 */
export const STAGE_ART_MAP = [
  { id: 1, name: 'Battlefield', sourceFile: 'stage_img1.jpg', resize: false },
  { id: 2, name: 'Big Battlefield', sourceFile: 'stage_img2.jpg', resize: false },
  { id: 3, name: 'Final Destination', sourceFile: 'stage_img3.jpg', resize: false },
  { id: 4, name: 'New Donk City Hall', sourceFile: 'stage_img100.jpg', resize: false },
  { id: 5, name: 'Great Plateau Tower', sourceFile: 'stage_img101.jpg', resize: false },
  { id: 6, name: 'Moray Towers', sourceFile: 'stage_img102.jpg', resize: false },
  { id: 7, name: "Dracula's Castle", sourceFile: 'stage_img103.jpg', resize: false },
  { id: 8, name: 'Mementos', sourceFile: 'stage_addition_img1.jpg', resize: true },
  { id: 9, name: "Yggdrasil's Altar", sourceFile: 'stage_addition_img2.jpg', resize: true },
  { id: 10, name: 'Spiral Mountain', sourceFile: 'stage_addition_img3.jpg', resize: true },
  { id: 11, name: "Peach's Castle", sourceFile: 'stage_img4.jpg', resize: false },
  { id: 12, name: 'Mushroom Kingdom', sourceFile: 'stage_img10.jpg', resize: false },
  { id: 13, name: "Princess Peach's Castle", sourceFile: 'stage_img11.jpg', resize: false },
  { id: 14, name: 'Rainbow Cruise', sourceFile: 'stage_img12.jpg', resize: false },
  { id: 15, name: 'Mushroom Kingdom II', sourceFile: 'stage_img26.jpg', resize: false },
  { id: 16, name: 'Delfino Plaza', sourceFile: 'stage_img30.jpg', resize: false },
  { id: 17, name: "Luigi's Mansion", sourceFile: 'stage_img49.jpg', resize: false },
  { id: 18, name: 'Mushroomy Kingdom', sourceFile: 'stage_img31.jpg', resize: false },
  { id: 19, name: 'Figure-8 Circuit', sourceFile: 'stage_img32.jpg', resize: false },
  { id: 20, name: 'Mario Bros.', sourceFile: 'stage_img53.jpg', resize: false },
  { id: 21, name: '3D Land', sourceFile: 'stage_img56.jpg', resize: false },
  { id: 22, name: 'Golden Plains', sourceFile: 'stage_img57.jpg', resize: false },
  { id: 23, name: 'Paper Mario', sourceFile: 'stage_img58.jpg', resize: false },
  { id: 24, name: 'Mushroom Kingdom U', sourceFile: 'stage_img74.jpg', resize: false },
  { id: 25, name: 'Mario Galaxy', sourceFile: 'stage_img75.jpg', resize: false },
  { id: 26, name: 'Mario Circuit', sourceFile: 'stage_img76.jpg', resize: false },
  { id: 27, name: 'Super Mario Maker', sourceFile: 'stage_img96.jpg', resize: false },
  { id: 28, name: 'Kongo Jungle', sourceFile: 'stage_img5.jpg', resize: false },
  { id: 29, name: 'Kongo Falls', sourceFile: 'stage_img13.jpg', resize: false },
  { id: 30, name: 'Jungle Japes', sourceFile: 'stage_img14.jpg', resize: false },
  { id: 31, name: '75m', sourceFile: 'stage_img52.jpg', resize: false },
  { id: 32, name: 'Super Happy Tree', sourceFile: 'stage_img7.jpg', resize: false },
  { id: 33, name: "Yoshi's Island (Melee)", sourceFile: 'stage_img18.jpg', resize: false },
  { id: 34, name: "Yoshi's Story", sourceFile: 'stage_img19.jpg', resize: false },
  { id: 35, name: 'Yoshi’s Island', sourceFile: 'stage_img37.jpg', resize: false },
  { id: 36, name: 'Hyrule Castle', sourceFile: 'stage_img6.jpg', resize: false },
  { id: 37, name: 'Great Bay', sourceFile: 'stage_img15.jpg', resize: false },
  { id: 38, name: 'Temple', sourceFile: 'stage_img16.jpg', resize: false },
  { id: 39, name: 'Bridge of Eldin', sourceFile: 'stage_img34.jpg', resize: false },
  { id: 40, name: 'Pirate Ship', sourceFile: 'stage_img50.jpg', resize: false },
  { id: 41, name: 'Gerudo Valley', sourceFile: 'stage_img59.jpg', resize: false },
  { id: 42, name: 'Spirit Train', sourceFile: 'stage_img60.jpg', resize: false },
  { id: 43, name: 'Skyloft', sourceFile: 'stage_img77.jpg', resize: false },
  { id: 44, name: 'Brinstar', sourceFile: 'stage_img17.jpg', resize: false },
  { id: 45, name: 'Brinstar Depths', sourceFile: 'stage_img27.jpg', resize: false },
  { id: 46, name: 'Norfair', sourceFile: 'stage_img35.jpg', resize: false },
  { id: 47, name: 'Frigate Orpheon', sourceFile: 'stage_img36.jpg', resize: false },
  { id: 48, name: 'Dream Land', sourceFile: 'stage_img8.jpg', resize: false },
  { id: 49, name: 'Fountain of Dreams', sourceFile: 'stage_img20.jpg', resize: false },
  { id: 50, name: 'Green Greens', sourceFile: 'stage_img21.jpg', resize: false },
  { id: 51, name: 'Halberd', sourceFile: 'stage_img38.jpg', resize: false },
  { id: 52, name: 'Dream Land GB', sourceFile: 'stage_img61.jpg', resize: false },
  { id: 53, name: 'The Great Cave Offensive', sourceFile: 'stage_img78.jpg', resize: false },
  { id: 54, name: 'Corneria', sourceFile: 'stage_img22.jpg', resize: false },
  { id: 55, name: 'Venom', sourceFile: 'stage_img23.jpg', resize: false },
  { id: 56, name: 'Lylat Cruise', sourceFile: 'stage_img39.jpg', resize: false },
  { id: 57, name: 'Saffron City', sourceFile: 'stage_img9_en.jpg', resize: false },
  { id: 58, name: 'Pokémon Stadium', sourceFile: 'stage_img24.jpg', resize: false },
  { id: 59, name: 'Pokémon Stadium 2', sourceFile: 'stage_img40.jpg', resize: false },
  { id: 60, name: 'Spear Pillar', sourceFile: 'stage_img51.jpg', resize: false },
  { id: 61, name: 'Unova Pokémon League', sourceFile: 'stage_img62.jpg', resize: false },
  { id: 62, name: 'Prism Tower', sourceFile: 'stage_img63.jpg', resize: false },
  { id: 63, name: 'Kalos Pokémon League', sourceFile: 'stage_img79.jpg', resize: false },
  { id: 64, name: 'Big Blue', sourceFile: 'stage_img28.jpg', resize: false },
  { id: 65, name: 'Port Town Aero Dive', sourceFile: 'stage_img41.jpg', resize: false },
  { id: 66, name: 'Mute City SNES', sourceFile: 'stage_img64.jpg', resize: false },
  { id: 67, name: 'Onett', sourceFile: 'stage_img25.jpg', resize: false },
  { id: 68, name: 'Fourside', sourceFile: 'stage_img29.jpg', resize: false },
  { id: 69, name: 'New Pork City', sourceFile: 'stage_img45.jpg', resize: false },
  { id: 70, name: 'Magicant', sourceFile: 'stage_img65.jpg', resize: false },
  { id: 71, name: 'Summit', sourceFile: 'stage_img46.jpg', resize: false },
  { id: 72, name: 'Castle Siege', sourceFile: 'stage_img42.jpg', resize: false },
  { id: 73, name: 'Arena Ferox', sourceFile: 'stage_img66.jpg', resize: false },
  { id: 74, name: 'Coliseum', sourceFile: 'stage_img80.jpg', resize: false },
  { id: 75, name: 'Flat Zone X', sourceFile: 'stage_img81_en.jpg', resize: false },
  { id: 76, name: 'Skyworld', sourceFile: 'stage_img47.jpg', resize: false },
  { id: 77, name: 'Reset Bomb Forest', sourceFile: 'stage_img67.jpg', resize: false },
  { id: 78, name: "Palutena's Temple", sourceFile: 'stage_img82.jpg', resize: false },
  { id: 79, name: 'WarioWare  Inc.', sourceFile: 'stage_img33.jpg', resize: false },
  { id: 80, name: 'Gamer', sourceFile: 'stage_img83.jpg', resize: false },
  { id: 81, name: 'Distant Planet', sourceFile: 'stage_img43.jpg', resize: false },
  { id: 82, name: 'Garden of Hope', sourceFile: 'stage_img84.jpg', resize: false },
  { id: 83, name: 'Smashville', sourceFile: 'stage_img44.jpg', resize: false },
  { id: 84, name: 'Tortimer Island', sourceFile: 'stage_img68.jpg', resize: false },
  { id: 85, name: 'Town and City', sourceFile: 'stage_img85_en.jpg', resize: false },
  { id: 86, name: 'Boxing Ring', sourceFile: 'stage_img87.jpg', resize: false },
  { id: 87, name: 'Wii Fit Studio', sourceFile: 'stage_img86.jpg', resize: false },
  { id: 88, name: 'Gaur Plain', sourceFile: 'stage_img88.jpg', resize: false },
  { id: 89, name: 'Duck Hunt', sourceFile: 'stage_img89.jpg', resize: false },
  { id: 90, name: 'Shadow Moses Island', sourceFile: 'stage_img48.jpg', resize: false },
  { id: 91, name: 'Green Hill Zone', sourceFile: 'stage_img55.jpg', resize: false },
  { id: 92, name: 'Windy Hill Zone', sourceFile: 'stage_img93.jpg', resize: false },
  { id: 93, name: 'Wily Castle', sourceFile: 'stage_img94.jpg', resize: false },
  { id: 94, name: 'Pac-Land', sourceFile: 'stage_img95.jpg', resize: false },
  { id: 95, name: 'Suzaku Castle', sourceFile: 'stage_img97.jpg', resize: false },
  { id: 96, name: 'Midgar', sourceFile: 'stage_img98.jpg', resize: false },
  { id: 97, name: 'Umbra Clock Tower', sourceFile: 'stage_img99.jpg', resize: false },
  { id: 98, name: 'Hanenbow', sourceFile: 'stage_img54.jpg', resize: false },
  { id: 99, name: 'PictoChat 2', sourceFile: 'stage_img73_en.jpg', resize: false },
  { id: 100, name: 'Balloon Fight', sourceFile: 'stage_img69.jpg', resize: false },
  { id: 101, name: 'Living Room', sourceFile: 'stage_img70.jpg', resize: false },
  { id: 102, name: 'Find Mii', sourceFile: 'stage_img71.jpg', resize: false },
  { id: 103, name: 'Tomodachi Life', sourceFile: 'stage_img72.jpg', resize: false },
  { id: 104, name: 'Wrecking Crew', sourceFile: 'stage_img90.jpg', resize: false },
  { id: 105, name: 'Pilotwings', sourceFile: 'stage_img91.jpg', resize: false },
  { id: 106, name: 'Wuhu Island', sourceFile: 'stage_img92.jpg', resize: false },
  { id: 107, name: 'Momentos', sourceFile: 'stage_addition_img1.jpg', resize: true },
  { id: 108, name: "Yggdrasil's Altar", sourceFile: 'stage_addition_img2.jpg', resize: true },
  { id: 109, name: 'Spiral Mountain', sourceFile: 'stage_addition_img3.jpg', resize: true },
  { id: 110, name: 'King of Fighters Stadium', sourceFile: 'stage_addition_img4.jpg', resize: true },
  { id: 111, name: 'Garreg Mach Monastery', sourceFile: 'stage_addition_img5.jpg', resize: true },
  { id: 112, name: 'Spring Stadium', sourceFile: 'stage_addition_img6.jpg', resize: true },
  { id: 113, name: 'Small Battlefield', sourceFile: 'stage_img104.jpg', resize: false },
  { id: 114, name: 'Minecraft World', sourceFile: 'stage_addition_img7.jpg', resize: true },
  { id: 115, name: 'Northern Cave', sourceFile: 'stage_addition_img8.jpg', resize: true },
  { id: 116, name: 'Cloud Sea of Alrest', sourceFile: 'stage_addition_img9.jpg', resize: true },
  { id: 117, name: 'Mishima Dojo', sourceFile: 'stage_addition_img10.jpg', resize: true },
];

/**
 * Pure kebab-slug function, matching the convention set by the existing 10
 * images (e.g. `1-battlefield.jpg`, `40-pokemon-stadium-2.jpg`). Strips
 * diacritics (NFD normalize + combining-mark strip) and apostrophes/periods
 * before hyphenating, so "Yoshi's Story" -> `yoshis-story`, "Pokémon Stadium
 * 2" -> `pokemon-stadium-2`, "WarioWare  Inc." -> `warioware-inc`, "Town and
 * City" -> `town-and-city`.
 */
export function slug(name) {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’.]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function acquireOne({ id, name, sourceFile, resize }) {
  const sourceUrl = `${BASE}/${sourceFile}`;
  const outPath = resolve(outDir, `${id}-${slug(name)}.jpg`);
  let res;
  try {
    res = await fetch(sourceUrl);
  } catch (err) {
    console.error(`FAILED ${id} (${name}): fetch threw ${err.message}`);
    return { status: 'failed', id };
  }
  if (!res.ok) {
    console.error(`FAILED ${id} (${name}): HTTP ${res.status} from ${sourceUrl}`);
    return { status: 'failed', id };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(outPath, buf);
  if (resize) {
    // sips arg order is height then width: `-z 421 750` => 750w x 421h.
    execFileSync('sips', ['-z', '421', '750', outPath], { stdio: 'ignore' });
  }
  console.log(`${id} -> /assets/stages/${id}-${slug(name)}.jpg`);
  return { status: 'written', id };
}

async function run() {
  let written = 0;
  let skippedPresent = 0;
  let failed = 0;
  for (const entry of STAGE_ART_MAP) {
    if (PRESENT_IDS.has(entry.id)) {
      skippedPresent += 1;
      continue;
    }
    const result = await acquireOne(entry);
    if (result.status === 'written') written += 1;
    else failed += 1;
  }
  console.log(`\n${written} written, ${skippedPresent} skipped-present, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await run();
}
