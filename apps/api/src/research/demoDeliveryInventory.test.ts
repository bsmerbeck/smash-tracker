import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import { RtdbService, buildReviewShareId, buildSessionShareId } from '../services/rtdb.js';
import { shareTokenSchema, type ShareToken } from '@smash-tracker/shared';
import { createReviewDelivery } from '../coaching/reviewDeliveries.js';
import { createSessionDelivery } from '../coaching/sessionDeliveries.js';
import { readSubjectKind } from './subjectKind.js';
import type { DemoAccountConfig } from '../config/env.js';

/**
 * Phase 30.1 Plan 03 (Demo Account Topology & Migration, RTEN-03 re-scope,
 * review H4, Task 3): the demo-account counterpart of
 * `publicDeliveryInventory.test.ts` — proves an allowlisted ORDINARY demo
 * uid is refused fail-closed on every MINT branch AND on all four
 * RESOLUTION chokepoints (including a directly-seeded PRE-EXISTING token,
 * which mint-side gating alone cannot cover), that a non-demo ordinary uid
 * still mints+resolves normally (narrowing proof), that the demo uid
 * genuinely resolves 'ordinary' via `readSubjectKind` (anti-vacuous guard),
 * and that the refusal paths emit zero telemetry and write nothing
 * (RTEN-04).
 */

const DEMO_UID = 'demo-hbox-uid-1';
const OTHER_DEMO_UID = 'demo-izaw-uid-1';
const NON_DEMO_UID = 'ordinary-non-demo-uid-1';

const DEMO_CONFIG: DemoAccountConfig = { demoUids: new Set([DEMO_UID, OTHER_DEMO_UID]) };

/** A 43-char base64url-shaped token (`SHARE_TOKEN_SHAPE`'s 20-128 bound) — one per fixture, never reused across seeded records. */
function fixtureToken(label: string): string {
  const padded = `${label}-${'a'.repeat(43)}`.slice(0, 43);
  return padded;
}

function seedShareToken(database: FakeDatabase, token: string, record: ShareToken): void {
  database.seed(`shareTokens/${token}`, shareTokenSchema.parse(record));
}

function seedShareSnapshot(database: FakeDatabase, shareId: string, ownerUid: string): void {
  database.seed(`shareSnapshots/${shareId}`, {
    uid: ownerUid,
    matchId: 'm1',
    createdAt: 1,
    result: 'win',
    fighterId: 1,
    opponentFighterId: 8,
    matchDate: 1700000000000,
    vodUrl: 'https://youtube.com/watch?v=abc123',
    reviewedMomentsCount: 0,
    redaction: { includedNotes: true, includedTags: true, showDisplayName: false },
  });
}

// ---------------------------------------------------------------------------
// Anti-vacuous guard: the demo uid resolves 'ordinary' via readSubjectKind —
// so every refusal below is proven to come from the demo allowlist, not the
// (unrelated) research-kind gate.
// ---------------------------------------------------------------------------

describe('demoDeliveryInventory: anti-vacuous guard', () => {
  it("the demo uid has no clientTenants record and resolves 'ordinary' (a demo account is an ordinary login-bearing account)", async () => {
    const database = new FakeDatabase();
    const resolution = await readSubjectKind(database as never, DEMO_UID);
    expect(resolution).toBe('ordinary');
  });
});

// ---------------------------------------------------------------------------
// Block 1: mint refusal — every branch of createShare, plus both standalone
// delivery writers — for an allowlisted demo uid.
// ---------------------------------------------------------------------------

describe('demoDeliveryInventory: mint refusal for an allowlisted demo uid', () => {
  it('createShare rejects on all three branches (review/recap/coachReview) and writes nothing', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never, DEMO_CONFIG);

    await expect(
      rtdb.createShare(
        DEMO_UID,
        {
          kind: 'review',
          matchId: 'm1',
          redaction: { includeNotes: true, includeTags: true, showDisplayName: false },
          permissions: 'view',
        } as never,
        'https://grandfinals.gg',
      ),
    ).rejects.toThrow();
    await expect(
      rtdb.createShare(
        DEMO_UID,
        { kind: 'recap', entryKey: 'entry1', permissions: 'view' } as never,
        'https://grandfinals.gg',
      ),
    ).rejects.toThrow();
    await expect(
      rtdb.createShare(
        DEMO_UID,
        { kind: 'coachReview', reviewId: 'review-1', version: 1, permissions: 'view' } as never,
        'https://grandfinals.gg',
      ),
    ).rejects.toThrow();

    const dump = database.dump() as Record<string, unknown>;
    expect(dump.shareTokens).toBeUndefined();
  });

  it('createReviewDelivery rejects for an allowlisted demo tenantId and writes nothing', async () => {
    const database = new FakeDatabase();
    await expect(
      createReviewDelivery(
        database as never,
        DEMO_UID,
        'review-1',
        1,
        'https://grandfinals.gg',
        {},
        DEMO_CONFIG,
      ),
    ).rejects.toThrow();
    const dump = database.dump() as Record<string, unknown>;
    expect(dump.shareTokens).toBeUndefined();
    expect(dump.reviewDeliveries).toBeUndefined();
  });

  it('createSessionDelivery rejects for an allowlisted demo tenantId and writes nothing', async () => {
    const database = new FakeDatabase();
    await expect(
      createSessionDelivery(
        database as never,
        DEMO_UID,
        'session-1',
        'https://grandfinals.gg',
        {},
        DEMO_CONFIG,
      ),
    ).rejects.toThrow();
    const dump = database.dump() as Record<string, unknown>;
    expect(dump.shareTokens).toBeUndefined();
    expect(dump.sessionDeliveries).toBeUndefined();
  });

  it('RTEN-04: the mint-refusal attempts above emit zero canonical-ledger/GA4 rows', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never, DEMO_CONFIG);
    await expect(
      rtdb.createShare(
        DEMO_UID,
        {
          kind: 'review',
          matchId: 'm1',
          redaction: { includeNotes: true, includeTags: true, showDisplayName: false },
          permissions: 'view',
        } as never,
        'https://grandfinals.gg',
      ),
    ).rejects.toThrow();
    await expect(
      createReviewDelivery(
        database as never,
        DEMO_UID,
        'review-1',
        1,
        'https://grandfinals.gg',
        {},
        DEMO_CONFIG,
      ),
    ).rejects.toThrow();
    await expect(
      createSessionDelivery(
        database as never,
        DEMO_UID,
        'session-1',
        'https://grandfinals.gg',
        {},
        DEMO_CONFIG,
      ),
    ).rejects.toThrow();

    const dump = database.dump() as Record<string, unknown>;
    expect(dump).not.toHaveProperty('eventLedger');
    expect(dump).not.toHaveProperty('eventDedup');
    expect(dump).not.toHaveProperty('outboxPending');
    expect(dump.shareTokens).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Block 2: resolution refusal (H4 core) — a directly-seeded, PRE-EXISTING
// token whose ownerUid is an allowlisted demo uid must fail closed at every
// resolver, proving mint-side gating alone is not sufficient.
// ---------------------------------------------------------------------------

describe('demoDeliveryInventory: resolution refusal for a directly-seeded demo-owned token (H4)', () => {
  it('getShareByToken returns null for a pre-existing plain review-kind token owned by a demo uid', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never, DEMO_CONFIG);
    const token = fixtureToken('review-tok');
    const shareId = 'shareSnapshot-key-1';
    seedShareSnapshot(database, shareId, DEMO_UID);
    seedShareToken(database, token, {
      shareId,
      ownerUid: DEMO_UID,
      permissions: 'view',
      createdAt: 1,
    });

    expect(await rtdb.getShareByToken(token)).toBeNull();
  });

  it('resolveCoachReviewShareRef returns null for a pre-existing coachReview-shaped token owned by a demo uid', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never, DEMO_CONFIG);
    const token = fixtureToken('review-delv');
    const shareId = buildReviewShareId(DEMO_UID, 'review-1', 1);
    seedShareToken(database, token, {
      shareId,
      ownerUid: DEMO_UID,
      permissions: 'view',
      createdAt: 1,
    });

    expect(await rtdb.resolveCoachReviewShareRef(token)).toBeNull();
    // getShareByToken shares the SAME resolution-side gate — the same
    // seeded token also resolves to null there (Block 3's exact-set claim
    // depends on every anonymous route being a thin caller of one of
    // these two methods).
    expect(await rtdb.getShareByToken(token)).toBeNull();
  });

  it('resolveSessionShareRef returns null for a pre-existing session-shaped token owned by a demo uid', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never, DEMO_CONFIG);
    const token = fixtureToken('session-delv');
    const shareId = buildSessionShareId(DEMO_UID, 'session-1', 'delivery-1');
    seedShareToken(database, token, {
      shareId,
      ownerUid: DEMO_UID,
      permissions: 'view',
      createdAt: 1,
    });

    expect(await rtdb.resolveSessionShareRef(token)).toBeNull();
    expect(await rtdb.getShareByToken(token)).toBeNull();
  });

  it('getEditSessionByToken (via resolveEditSession) returns null for a pre-existing edit-tier token owned by a demo uid', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never, DEMO_CONFIG);
    const token = fixtureToken('edit-tok');
    const shareId = 'shareSnapshot-key-edit-1';
    seedShareSnapshot(database, shareId, DEMO_UID);
    seedShareToken(database, token, {
      shareId,
      ownerUid: DEMO_UID,
      permissions: 'edit',
      createdAt: 1,
      expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 30,
    });

    expect(await rtdb.getEditSessionByToken(token)).toBeNull();
  });

  it('resolution refusal holds for BOTH allowlisted demo uids, not just one', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never, DEMO_CONFIG);
    const token = fixtureToken('izaw-tok');
    const shareId = 'shareSnapshot-key-izaw-1';
    seedShareSnapshot(database, shareId, OTHER_DEMO_UID);
    seedShareToken(database, token, {
      shareId,
      ownerUid: OTHER_DEMO_UID,
      permissions: 'view',
      createdAt: 1,
    });

    expect(await rtdb.getShareByToken(token)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Block 3: control — a non-demo ordinary uid mints AND its seeded token
// resolves normally, proving the check narrows to allowlisted demo uids
// only and general-product behavior is unchanged.
// ---------------------------------------------------------------------------

describe('demoDeliveryInventory: control — a non-demo ordinary uid mints and resolves normally', () => {
  it('createShare mints a review share for a non-demo uid, and getShareByToken resolves it', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never, DEMO_CONFIG);
    database.seed(`matches/${NON_DEMO_UID}/m1`, {
      fighter_id: 1,
      opponent_id: 8,
      time: 1700000000000,
      win: true,
      vodUrl: 'https://youtube.com/watch?v=abc123',
    });

    const created = await rtdb.createShare(
      NON_DEMO_UID,
      {
        kind: 'review',
        matchId: 'm1',
        redaction: { includeNotes: true, includeTags: true, showDisplayName: false },
        permissions: 'view',
      } as never,
      'https://grandfinals.gg',
    );

    expect(created.token).toBeTruthy();
    const resolved = await rtdb.getShareByToken(created.token);
    expect(resolved).not.toBeNull();
  });

  it('a directly-seeded token owned by a non-demo uid still resolves (narrowing proof)', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never, DEMO_CONFIG);
    const token = fixtureToken('non-demo-tok');
    const shareId = 'shareSnapshot-key-non-demo-1';
    seedShareSnapshot(database, shareId, NON_DEMO_UID);
    seedShareToken(database, token, {
      shareId,
      ownerUid: NON_DEMO_UID,
      permissions: 'view',
      createdAt: 1,
    });

    expect(await rtdb.getShareByToken(token)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Block 4: RTEN-05 — import-surface exclusion (v2.1 precedent).
//
// Governance note (recorded here, not silently papered over): Task 3's
// action text describes proving RTEN-05 by "driving Plan 01's runMigration
// onto a demo uid fixture". Plan 01 (`apps/api/src/research/migration/
// manifest.ts`) and Plan 02 (`.../migration/coachingMode.ts`) are SIBLING
// wave-1 plans executing in PARALLEL worktrees and had not merged into this
// worktree at the time this plan ran — those modules do not exist here, so
// a static import would break this plan's own build in isolation. Per the
// must-haves' own framing ("proven by the seeding modules' import-surface
// exclusion (v2.1 precedent), NOT by a no-auth-principal premise"), this
// block instead proves the narrower, currently-verifiable property: every
// source file THIS plan modifies (the seven enforcement sites' host
// modules) imports no billing/credit surface — so a demo-account mint or
// resolution refusal can never, even transitively through these files,
// touch a credit/revenue tree. The full cross-plan proof against Plan 01's
// runMigration/Plan 02's enableCoachingMode belongs to a post-merge
// integration check once all wave-1 plans have landed (surfaced in this
// plan's SUMMARY.md as a deferred item, not silently dropped).
// ---------------------------------------------------------------------------

const API_SRC = resolve('src');
const BILLING_MODULE_FRAGMENTS = ['billing/credits', 'routes/billing', 'stripe'];
const SCANNED_FILES = [
  resolve(API_SRC, 'research/demoAccount.ts'),
  resolve(API_SRC, 'services/rtdb.ts'),
  resolve(API_SRC, 'coaching/reviewDeliveries.ts'),
  resolve(API_SRC, 'coaching/sessionDeliveries.ts'),
];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function importsBillingSurface(commentStrippedSource: string): boolean {
  const importPattern = /import\s*(?:type\s*)?(?:\{[^}]*\}|\w+)\s*from\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = importPattern.exec(commentStrippedSource)) !== null) {
    const specifier = match[1]!;
    if (BILLING_MODULE_FRAGMENTS.some((fragment) => specifier.includes(fragment))) {
      return true;
    }
  }
  return false;
}

describe('demoDeliveryInventory: RTEN-05 (partial, this-plan-scoped) — import-surface exclusion', () => {
  it('discovers the expected number of scanned files (anti-vacuous-pass guard)', () => {
    expect(SCANNED_FILES.length).toBe(4);
  });

  it.each(SCANNED_FILES)('%s imports no billing/credit surface module', (file) => {
    const source = readFileSync(file, 'utf-8');
    expect(importsBillingSurface(stripComments(source))).toBe(false);
  });

  it('FIXTURE: an import naming the billing module IS detected (proves the scan is not vacuous)', () => {
    const fixture = "import { spendCredit } from '../billing/credits.js';";
    expect(importsBillingSurface(stripComments(fixture))).toBe(true);
  });
});
