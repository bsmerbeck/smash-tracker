import type { InsightTemplate } from './registry.js';
import { formNowTemplate } from './formNow.js';

/** Templates that apply regardless of the subject/cohort/roster segmentation — currently just `formNow`. */
export const CORE_TEMPLATES: InsightTemplate[] = [formNowTemplate];
