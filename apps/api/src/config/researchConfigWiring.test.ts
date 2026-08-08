import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildTestApp } from '../test-support/testApp.js';

/**
 * Phase 29 (Research Tenancy, Isolation & Governance Gate, D-04): the
 * production-wiring gate for the research-admin allowlist config, modeled
 * on `prepPaidWiring.test.ts` so the two wiring proofs read alike. A
 * config-null gate is only as good as its wiring — this proves BOTH the
 * runtime decoration behavior (via `buildTestApp`) and the
 * `apps/api/src/index.ts` source-level threading (via a content grep,
 * mirroring `prepPaidWiring.test.ts`'s style down to the anti-vacuous-pass
 * guard).
 */
describe('RESEARCH_ADMIN_UIDS wiring (D-04 config-null capability gate)', () => {
  it('decorates researchConfig as null when the research option is omitted entirely', () => {
    const { app } = buildTestApp();
    expect(app.researchConfig).toBeNull();
  });

  it('decorates researchConfig as null when the research option is explicitly null (omission and explicit null are identical)', () => {
    const { app } = buildTestApp({ research: null });
    expect(app.researchConfig).toBeNull();
  });

  it('decorates researchConfig with exactly the configured uids when two uids are passed', () => {
    const { app } = buildTestApp({ research: { adminUids: new Set(['uid-a', 'uid-b']) } });
    expect(app.researchConfig).not.toBeNull();
    expect(app.researchConfig?.adminUids).toEqual(new Set(['uid-a', 'uid-b']));
  });
});

describe('index.ts wires RESEARCH_ADMIN_UIDS through to buildApp (production-wiring gate)', () => {
  const indexSource = readFileSync(resolve('src/index.ts'), 'utf-8');

  it('discovers a non-trivial index.ts to scan (a silently-empty read would make every case below vacuously pass)', () => {
    expect(indexSource.length).toBeGreaterThan(500);
  });

  it('imports getResearchConfig from ./config/env.js', () => {
    expect(indexSource).toMatch(/getResearchConfig/);
  });

  it('calls getResearchConfig(env)', () => {
    expect(indexSource).toMatch(/getResearchConfig\(env\)/);
  });

  it('passes the resulting value into the buildApp({...}) option object under the research key', () => {
    const buildAppCallMatch = indexSource.match(/buildApp\(\{[\s\S]*?\}\);/);
    expect(buildAppCallMatch).not.toBeNull();
    const buildAppCall = buildAppCallMatch![0];
    expect(buildAppCall).toMatch(/\bresearch\b/);
  });
});
