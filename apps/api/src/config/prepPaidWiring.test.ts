import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getPrepPaidConfig, loadEnv } from './env.js';

/**
 * Phase 27 (Contextual Paid Prep Reports Behind the Activation Gate, RPT-04,
 * 27-CONTEXT.md line 25): the production-wiring gate for the paid-prep
 * activation flag. A config-null gate is only as good as its wiring — this
 * is a content-based grep-gate over `apps/api/src/index.ts` source text
 * (mirroring `apps/api/src/prep/importGraph.test.ts`'s style exactly, right
 * down to the anti-vacuous-pass guard), asserting that:
 *
 * - `getPrepPaidConfig` is imported and called there.
 * - Its result is threaded into the `buildApp({...})` option object under
 *   the `prepPaid` key.
 * - Exactly one startup `warn` call names the env var, so a misconfigured
 *   (i.e. gate-off) production deployment is obvious in Cloud Run logs.
 *
 * A future edit that stops reading the flag from the environment — deleting
 * the `getPrepPaidConfig(env)` call, dropping the `prepPaid` option, or
 * removing the startup warning — must fail CI loudly here, rather than
 * silently shipping an ungated paid, money-moving surface.
 */
describe('index.ts wires PREP_PAID_REPORTS_ENABLED through to buildApp (RPT-04 production-wiring gate)', () => {
  const indexSource = readFileSync(resolve('src/index.ts'), 'utf-8');

  it('discovers a non-trivial index.ts to scan (a silently-empty read would make every case below vacuously pass)', () => {
    expect(indexSource.length).toBeGreaterThan(500);
  });

  it('imports getPrepPaidConfig from ./config/env.js', () => {
    expect(indexSource).toMatch(/getPrepPaidConfig/);
  });

  it('calls getPrepPaidConfig(env)', () => {
    expect(indexSource).toMatch(/getPrepPaidConfig\(env\)/);
  });

  it('passes the resulting value into the buildApp({...}) option object under the prepPaid key', () => {
    const buildAppCallMatch = indexSource.match(/buildApp\(\{[\s\S]*?\}\);/);
    expect(buildAppCallMatch).not.toBeNull();
    const buildAppCall = buildAppCallMatch![0];
    expect(buildAppCall).toMatch(/\bprepPaid\b/);
  });

  it('contains exactly one startup warn call whose message names the env var', () => {
    const warnCalls = indexSource.match(/app\.log\.warn\([\s\S]*?\);/g) ?? [];
    const warnCallsNamingFlag = warnCalls.filter((call) =>
      call.includes('PREP_PAID_REPORTS_ENABLED'),
    );
    expect(warnCallsNamingFlag).toHaveLength(1);
  });
});

describe('default-OFF runtime proof (production ships UNSET)', () => {
  it('loadEnv over an environment with no paid-prep flag (only the required vars) yields a null prep-paid config', () => {
    const env = loadEnv({
      FIREBASE_DATABASE_URL: 'https://example-default-rtdb.firebaseio.com',
    });
    expect(getPrepPaidConfig(env)).toBeNull();
  });
});
