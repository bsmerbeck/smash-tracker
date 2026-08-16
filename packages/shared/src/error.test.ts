import { describe, expect, it } from 'vitest';
import {
  API_ERROR_CODES,
  DEMO_ACCOUNT_CHECKOUT_FORBIDDEN_CODE,
  errorResponseSchema,
} from './error.js';

/**
 * Phase 30.3 (Gate 6 capture-evidence hardening, item 2).
 *
 * `code` is the one member of this envelope that a sealed Gate-6 probe treats
 * as PROOF that the application refused. Everything below is about keeping
 * that promise honest: the member must be optional (so no existing refusal
 * changes shape), it must survive serialization (a stripped member would make
 * the operator's check unsatisfiable in production while passing in unit
 * tests), and its value must be a stable identifier rather than prose.
 */
describe('errorResponseSchema', () => {
  it('accepts the pre-existing envelope unchanged — `code` is OPTIONAL', () => {
    const legacy = { error: 'Forbidden', message: 'nope', statusCode: 403 };
    expect(errorResponseSchema.parse(legacy)).toEqual(legacy);
  });

  it('does not INVENT a code for an envelope that omitted one', () => {
    const parsed = errorResponseSchema.parse({
      error: 'Not Found',
      message: 'missing',
      statusCode: 404,
    });
    expect('code' in parsed).toBe(false);
    expect(parsed.code).toBeUndefined();
  });

  it('PRESERVES a supplied code through parse — the serializer must not strip it', () => {
    // fastify-type-provider-zod serializes responses THROUGH this schema, so
    // a member absent from it is silently dropped on the wire. That failure
    // mode is invisible to a handler-level unit test and fatal to the probe.
    const parsed = errorResponseSchema.parse({
      error: 'Forbidden',
      message: 'Credit purchases are not available for this account',
      statusCode: 403,
      code: DEMO_ACCOUNT_CHECKOUT_FORBIDDEN_CODE,
    });
    expect(parsed.code).toBe(DEMO_ACCOUNT_CHECKOUT_FORBIDDEN_CODE);
  });

  it('rejects an empty code — a present-but-blank identifier proves nothing', () => {
    expect(() =>
      errorResponseSchema.parse({ error: 'x', message: 'y', statusCode: 403, code: '' }),
    ).toThrow();
  });
});

describe('API error codes', () => {
  it('pins the demo-checkout code to its exact wire value', () => {
    // Pinned as a literal on purpose: this string is baked into every sealed
    // Gate-6 probe. Changing it invalidates that evidence, so it must never
    // be possible to change silently by renaming the constant.
    expect(DEMO_ACCOUNT_CHECKOUT_FORBIDDEN_CODE).toBe('demo_account_checkout_forbidden');
  });

  it('is a machine identifier, not a human message', () => {
    for (const code of API_ERROR_CODES) {
      expect(code).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(code).not.toMatch(/\s/);
    }
  });

  it('holds no duplicate values', () => {
    expect(new Set(API_ERROR_CODES).size).toBe(API_ERROR_CODES.length);
  });
});
