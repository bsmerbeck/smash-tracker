import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userProfileSchema } from '@smash-tracker/shared';

// `api.users.getMe` reads an auth header from the real Firebase web SDK,
// which needs env config this suite has no business supplying — same stub
// every other api-level web test installs (`@/test/mockAuth`).
vi.mock('@/lib/firebase', async () => {
  const mock = await import('@/test/mockAuth');
  return mock.firebaseLibMock();
});

const { api, ApiSchemaError } = await import('./api');

/**
 * Phase 30.3 (Gate 6 corrective, defect A1): the browser's `isDemoAccount`
 * REQUIREDNESS contract.
 *
 * There is deliberately no `@/lib/demoAccount.ts` module any more. It used to
 * export a `webUserProfileSchema` that took the shared `userProfileSchema`
 * — in which `isDemoAccount` is a required boolean — and re-opened the field
 * as `z.boolean().nullish()` for the browser only. The consequence was the
 * defect this file now locks against: a `GET /api/users/me` response that
 * omitted the field parsed SUCCESSFULLY, `useIsDemoAccount()` read the
 * absence as `false`, and every demo protection driven by that flag (the
 * banner, the Client Hub export affordance) silently disappeared with no
 * error raised anywhere.
 *
 * The enforcement site is `api.users.getMe` in `@/lib/api.ts`, which now
 * passes the shared schema straight through. These tests exercise THAT call
 * with a stubbed `fetch` — the real wire path — rather than a schema in
 * isolation, so the requiredness cannot be reintroduced by swapping the
 * schema at the call site while leaving a schema-unit test green.
 */

const SRC_ROOT = resolve('src');
const SELF_PATH = resolve('src/lib/demoAccount.test.ts');

/** Recursively collects every non-test `.ts`/`.tsx` source file under `dir` (mirrors `researchTelemetryIntegrity.test.ts`). */
function collectNonTestSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectNonTestSourceFiles(fullPath));
      continue;
    }
    if (/\.tsx?$/.test(entry.name) && !entry.name.includes('.test.')) {
      files.push(fullPath);
    }
  }
  return files;
}

const ALL_NON_TEST_SOURCE_FILES = collectNonTestSourceFiles(SRC_ROOT).filter(
  (file) => file !== SELF_PATH,
);

function relPath(absPath: string): string {
  return absPath.slice(resolve('.').length + 1);
}

/** Strips `//` and `/* *\/` comments so a comment-only mention never trips the scan. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/**
 * The exact defect shape: `isDemoAccount` declared as a zod boolean that is
 * then re-opened (`.nullish()`/`.optional()`/`.nullable()`/`.default()`), which
 * is what let an omitted field parse as a substituted `false`.
 */
const RE_OPENED_FLAG =
  /isDemoAccount\s*:\s*z\s*\.\s*boolean\s*\(\s*\)\s*\.\s*(?:nullish|optional|nullable|default)\s*\(/;

function stubProfileResponse(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify(body),
    }),
  );
}

/** A complete, valid `GET /api/users/me` body — every field the shared schema requires. */
function baseProfile() {
  return {
    uid: 'uid-1',
    email: 'test@example.com',
    fighters: { primary: [], secondary: [] },
    coachingModeEnabled: false,
    onboardingIntent: null,
    isDemoAccount: false,
  };
}

describe('GET /api/users/me requires isDemoAccount (no browser-side nullish override)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('anti-vacuous guard: the shared schema this call site uses declares isDemoAccount as REQUIRED', () => {
    expect(userProfileSchema.safeParse(baseProfile()).success).toBe(true);

    const withoutField: Record<string, unknown> = { ...baseProfile() };
    delete withoutField.isDemoAccount;
    expect(userProfileSchema.safeParse(withoutField).success).toBe(false);
  });

  it('REJECTS a response that omits isDemoAccount rather than substituting false', async () => {
    const withoutField: Record<string, unknown> = { ...baseProfile() };
    delete withoutField.isDemoAccount;
    stubProfileResponse(withoutField);

    await expect(api.users.getMe()).rejects.toBeInstanceOf(ApiSchemaError);
  });

  it('REJECTS an explicit null isDemoAccount (the exact shape the old .nullish() override accepted)', async () => {
    stubProfileResponse({ ...baseProfile(), isDemoAccount: null });

    await expect(api.users.getMe()).rejects.toBeInstanceOf(ApiSchemaError);
  });

  it('REJECTS an explicit undefined isDemoAccount', async () => {
    stubProfileResponse({ ...baseProfile(), isDemoAccount: undefined });

    await expect(api.users.getMe()).rejects.toBeInstanceOf(ApiSchemaError);
  });

  it('REJECTS a non-boolean isDemoAccount rather than coercing it', async () => {
    stubProfileResponse({ ...baseProfile(), isDemoAccount: 'true' });

    await expect(api.users.getMe()).rejects.toBeInstanceOf(ApiSchemaError);
  });

  it('positive control: a complete ordinary response parses and carries isDemoAccount: false', async () => {
    stubProfileResponse(baseProfile());

    await expect(api.users.getMe()).resolves.toMatchObject({ isDemoAccount: false });
  });

  it('positive control: a complete demo response parses and carries isDemoAccount: true', async () => {
    stubProfileResponse({ ...baseProfile(), isDemoAccount: true });

    await expect(api.users.getMe()).resolves.toMatchObject({ isDemoAccount: true });
  });

  it('still enforces every other field the shared schema requires', async () => {
    const withoutUid: Record<string, unknown> = { ...baseProfile() };
    delete withoutUid.uid;
    stubProfileResponse(withoutUid);

    await expect(api.users.getMe()).rejects.toBeInstanceOf(ApiSchemaError);
  });

  it('anti-vacuous guard: the whole-tree scan below discovers the app sources', () => {
    expect(ALL_NON_TEST_SOURCE_FILES.length).toBeGreaterThan(100);
  });

  it('no web source module re-opens isDemoAccount as optional/nullable/defaulted', () => {
    const offenders = ALL_NON_TEST_SOURCE_FILES.filter((file) =>
      RE_OPENED_FLAG.test(stripComments(readFileSync(file, 'utf-8'))),
    ).map(relPath);

    expect(offenders).toEqual([]);
  });

  it.each([
    'isDemoAccount: z.boolean().nullish(),',
    'isDemoAccount: z.boolean().optional(),',
    'isDemoAccount: z.boolean().nullable(),',
    'isDemoAccount: z.boolean().default(false),',
  ])('FIXTURE: the scan DOES detect a re-opened flag — %s', (fixture) => {
    expect(RE_OPENED_FLAG.test(stripComments(fixture))).toBe(true);
  });

  it('FIXTURE: the required shared declaration does NOT trip the scan (no false positives)', () => {
    expect(RE_OPENED_FLAG.test(stripComments('isDemoAccount: z.boolean(),'))).toBe(false);
  });
});
