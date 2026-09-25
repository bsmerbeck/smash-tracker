import type { Match } from '../../match.js';
import type {
  HorizonKey,
  Insight,
  InsightScope,
  InsightScopeKind,
  InsightTemplateId,
} from '../types.js';
import { CORE_TEMPLATES } from './core.js';
import { SUBJECT_TEMPLATES } from './subject.js';
import { COHORT_TEMPLATES } from './cohort.js';
import { ROSTER_TEMPLATES } from './roster.js';

/**
 * One insight template: a pure `build` function plus the metadata the
 * registry, the rail and the drill-down door builder (39.1-19) read off it.
 *
 * `windowExpressible` (UI-SPEC §13.13a) is a REQUIRED (non-optional) boolean
 * — declared here and NOWHERE else under `packages/shared/src/insight/`.
 * `true` means the template's counted game set is reproducible from the
 * existing drill-down window axes (a contiguous from/to span plus scope
 * axes), so 39.1-19 may give it the counted-games door; `false` means the
 * set is non-contiguous and the template gets its named fallback route door
 * instead. Making it REQUIRED rather than optional is what forces every
 * later template author to state the answer — an absent optional property
 * reads as `undefined`, which is neither branch. Plans 39.1-03, 39.1-04 and
 * 39.1-05 set it on the templates they create; plans 39.1-05 and 39.1-19
 * read it off this registry rather than a hand-written id list.
 */
export interface InsightTemplate {
  id: InsightTemplateId;
  /** The template's primary/default scope kind — descriptive metadata, not a hard constraint: a caller may still invoke `build` with any `InsightScope` its own logic can interpret (e.g. `formNow` is reused at account, character and player scope per UI-SPEC §9.4). */
  scopeKind: InsightScopeKind;
  assertsDirection: boolean;
  windowExpressible: boolean;
  build(input: {
    matches: Match[];
    scope: InsightScope;
    horizon: HorizonKey;
    nowMs: number;
  }): Insight[];
}

/**
 * The closed insight template registry — composed from exactly four segment
 * arrays. `subject.ts` (39.1-03), `cohort.ts` (39.1-04) and `roster.ts`
 * (39.1-05) are declared extension points, empty in this plan; a registry
 * test asserts this composed set always equals their union, so a template a
 * later plan adds to one segment can never be silently orphaned from the
 * registry a caller actually iterates.
 */
export const INSIGHT_TEMPLATES: InsightTemplate[] = [
  ...CORE_TEMPLATES,
  ...SUBJECT_TEMPLATES,
  ...COHORT_TEMPLATES,
  ...ROSTER_TEMPLATES,
];
