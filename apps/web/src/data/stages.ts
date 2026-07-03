/**
 * Stage reference data now lives in @smash-tracker/shared (the API needs it
 * for start.gg stage mapping); this module re-exports it so existing imports
 * keep working.
 */
export {
  StageList,
  stagesById,
  getStageById,
  NO_SELECTION_STAGE,
  UNKNOWN_STAGE,
} from '@smash-tracker/shared';
