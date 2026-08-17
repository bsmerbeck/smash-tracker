/**
 * Phase 30 UAT driver (owner-directed, GOV-02-STARTGG-SCOPE-R1) — drives the
 * SAME service functions the admin routes call, via the admin SDK against
 * the real RTDB (v2.1 seeder / prod-probe precedent). Read-only unless a
 * mutating subcommand is named explicitly.
 *
 *   pnpm exec tsx scripts/uatResearchDrive.ts status
 *   pnpm exec tsx scripts/uatResearchDrive.ts resolve-standings <tournamentSlug>
 *   pnpm exec tsx scripts/uatResearchDrive.ts verify-player <playerId>
 *   pnpm exec tsx scripts/uatResearchDrive.ts create-tenant <label>
 *   pnpm exec tsx scripts/uatResearchDrive.ts confirm <tenantId> <playerId[,playerId2...]> <primaryPlayerId>
 *   pnpm exec tsx scripts/uatResearchDrive.ts start-run <tenantId> <playerId>
 *   pnpm exec tsx scripts/uatResearchDrive.ts advance <tenantId> <runId> [maxInvocations]
 *   pnpm exec tsx scripts/uatResearchDrive.ts coverage <tenantId>
 */
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
import { listResearchTenants, createResearchTenant } from '../src/research/tenants.js';
import { confirmIdentityPlayers, readIdentityMapping } from '../src/research/ingestion/identity.js';
import {
  createOrResumeBackfillRun,
  readBackfillRun,
  readTenantIngestionState,
} from '../src/research/ingestion/backfillRun.js';
import { readCoverageSnapshot } from '../src/research/ingestion/rollup.js';
import { runResearchBackfillBatch } from '../src/jobs/researchBackfillBatch.js';
import { fetchResearchSetsPage, gqlRawForUat } from './uatStartggHelpers.js';

const OWNER_UID = 'i7UM54MfCCSNusp85QeEKNQJ9fv2';
const token = process.env.STARTGG_API_TOKEN ?? process.env.STARTGG_PERSONAL_TOKEN;
if (!token) {
  console.error('STARTGG_API_TOKEN is required');
  process.exit(2);
}

initializeApp({
  credential: applicationDefault(),
  databaseURL: 'https://smash-tracker-f97b7.firebaseio.com',
});
const db = getDatabase();

const [cmd, ...args] = process.argv.slice(2);

async function main(): Promise<void> {
  switch (cmd) {
    case 'status': {
      const rows = await listResearchTenants(db, OWNER_UID);
      console.log('research tenants:', JSON.stringify(rows, null, 2));
      for (const row of rows as { clientId: string }[]) {
        const state = await readTenantIngestionState(db, row.clientId);
        const mapping = await readIdentityMapping(db, row.clientId);
        console.log(
          row.clientId,
          'activeRunId:',
          state?.activeRunId ?? null,
          'confirmed:',
          Object.keys(mapping?.confirmedPlayerIds ?? {}),
        );
      }
      return;
    }
    case 'resolve-standings': {
      const slug = args[0]!;
      const data = await gqlRawForUat(
        token!,
        `query($slug:String!){ tournament(slug:$slug){ id name events(filter:{videogameId:1386}){ id name standings(query:{perPage:8}){ nodes{ placement entrant{ name participants{ player{ id gamerTag } } } } } } } }`,
        { slug },
      );
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    case 'verify-player': {
      const playerId = args[0]!;
      const page = await fetchResearchSetsPage(token!, playerId, 1, 5, {});
      const tags = new Set<string>();
      for (const set of page.sets) {
        for (const slot of set.slots ?? []) {
          for (const p of slot?.entrant?.participants ?? []) {
            if (p?.player?.id != null && String(p.player.id) === playerId && p.player.gamerTag) {
              tags.add(p.player.gamerTag);
            }
          }
        }
      }
      console.log(
        JSON.stringify({
          playerId,
          totalPages: page.totalPages,
          sampleSets: page.sets.length,
          observedTags: [...tags],
        }),
      );
      return;
    }
    case 'create-tenant': {
      const label = args[0]!;
      const result = await createResearchTenant(db, OWNER_UID, label);
      console.log(JSON.stringify(result));
      return;
    }
    case 'confirm': {
      const [tenantId, idsCsv, primaryId] = args as [string, string, string];
      const inputs = idsCsv.split(',').map((playerId) => ({
        playerId,
        ...(playerId === primaryId ? { primary: true } : {}),
      }));
      const result = await confirmIdentityPlayers(db, tenantId, OWNER_UID, inputs);
      console.log(JSON.stringify(result));
      return;
    }
    case 'start-run': {
      const [tenantId, playerId] = args as [string, string];
      const result = await createOrResumeBackfillRun(db, {
        tenantId,
        playerId,
        requestedByUid: OWNER_UID,
        mode: 'full',
      });
      console.log(JSON.stringify(result));
      return;
    }
    case 'advance': {
      const [tenantId, runId, maxStr] = args as [string, string, string?];
      const maxInvocations = maxStr ? Number(maxStr) : 500;
      for (let i = 0; i < maxInvocations; i += 1) {
        const result = await runResearchBackfillBatch(db, token!, tenantId, runId, {
          ownerId: `uat-${process.pid}-${i}`,
        });
        console.log(
          `[inv ${i}] stop=${result.stopReason ?? 'n/a'} completed=${result.completed} pages=${result.pagesProcessed ?? '?'} reason=${result.reason ?? ''}`,
        );
        if (result.completed) {
          console.log('RUN COMPLETE');
          return;
        }
        if (result.stopReason === 'failed' || result.status === 'failed') {
          console.error('RUN FAILED:', result.reason ?? result.stopReason);
          process.exitCode = 1;
          return;
        }
        if (result.stopReason === 'backoff-pending') {
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
      console.log('invocation cap reached without completion (resumable — rerun advance)');
      return;
    }
    case 'coverage': {
      const tenantId = args[0]!;
      const snapshot = await readCoverageSnapshot(db, tenantId);
      console.log(JSON.stringify(snapshot, null, 2));
      const state = await readTenantIngestionState(db, tenantId);
      if (state?.activeRunId) {
        const run = await readBackfillRun(db, tenantId, state.activeRunId);
        console.log(
          'active run:',
          JSON.stringify(
            { runId: state.activeRunId, status: run?.status, cursor: run?.cursor },
            null,
            2,
          ),
        );
      }
      return;
    }
    default:
      console.error(`unknown subcommand: ${cmd ?? '(none)'}`);
      process.exit(2);
  }
}

await main();
process.exit(process.exitCode ?? 0);
