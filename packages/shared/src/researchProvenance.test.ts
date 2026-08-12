import { describe, expect, it } from 'vitest';
import {
  RESEARCH_PROVENANCE_CONTENT_TYPES,
  RESEARCH_PROVENANCE_ORIGINS,
} from './researchProvenance.js';

describe('RESEARCH_PROVENANCE_ORIGINS', () => {
  it('has exactly manual then liquipedia, in that order', () => {
    expect(RESEARCH_PROVENANCE_ORIGINS).toEqual(['manual', 'liquipedia']);
  });
});

describe('RESEARCH_PROVENANCE_CONTENT_TYPES', () => {
  it('has exactly note, vod-reference, stage-observation, in that order', () => {
    expect(RESEARCH_PROVENANCE_CONTENT_TYPES).toEqual([
      'note',
      'vod-reference',
      'stage-observation',
    ]);
  });
});
