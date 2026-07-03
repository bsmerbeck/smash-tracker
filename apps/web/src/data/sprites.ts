/**
 * Fighter reference data now lives in @smash-tracker/shared (the API needs it
 * for start.gg character mapping); this module re-exports it so existing
 * imports keep working.
 */
export { SpriteList, spritesById, getFighterById } from '@smash-tracker/shared';
