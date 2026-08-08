import { describe, expect, it } from 'vitest';
import {
  fetchPlayerSetsPage,
  fetchResearchSetsPage,
  fetchResearchSetsProbePage,
} from './client.js';

/**
 * Phase 30 Plan 02, Task 2 — the two-sided behavioral lock between
 * `startgg/sync.ts`'s legacy personal-sync query and this phase's new
 * lossless research query.
 *
 * `importPlayerMatches` (`startgg/sync.ts`) is a bounded, best-effort
 * personal sync: `MAX_PAGES = 40`, DQ sets are silently skipped, unmapped
 * characters/stages are silently dropped. That silent-drop semantics is
 * CORRECT for its own purpose — a user re-syncing their own recent history
 * doesn't need every DQ/bye/walkover accounted for — but it is exactly
 * wrong for the research backfill's lossless contract (ING-03/04), which
 * must capture bye slots, DQ flags, and set state that the legacy query
 * never asks for. This file is the machine check that the two paths never
 * converge by accident: a future edit that adds a research-only field to
 * the legacy query, or drops a lossless field from the research query,
 * fails here — not by source-grepping `client.ts` (which legitimately
 * contains both query texts), but by asserting over the ACTUAL captured
 * outgoing request body each function sends.
 */

/** Collapses whitespace so query-text comparisons survive reformatting. */
function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, ' ').trim();
}

/** Copied verbatim from `SETS_QUERY` in `client.ts` — this file's baseline. */
const EXPECTED_LEGACY_QUERY = `query PlayerSets($playerId: ID!, $page: Int!, $perPage: Int!) {
  player(id: $playerId) {
    sets(perPage: $perPage, page: $page) {
      pageInfo { totalPages }
      nodes {
        id
        completedAt
        fullRoundText
        round
        displayScore
        totalGames
        vodUrl
        event { id name slug isOnline numEntrants videogame { id } tournament { name } }
        slots {
          entrant {
            id
            name
            participants { player { id gamerTag } user { slug } }
            seeds { seedNum }
            standing { placement }
          }
        }
        games {
          winnerId
          stage { id name }
          selections { character { id } entrant { id } }
          entrant1Score
          entrant2Score
        }
      }
    }
  }
}`;

/**
 * The lossless selections `RESEARCH_SETS_QUERY` adds that `SETS_QUERY`
 * (the legacy query) must never gain. Kept in THIS test file only — never
 * a scan of `client.ts`, which legitimately contains all of these names in
 * the research query.
 */
const RESEARCH_ONLY_SELECTIONS = [
  'isDisqualified',
  'initialSeedNum',
  'state',
  'identifier',
  'createdAt',
  'updatedAt',
];

function capturingFetch(capture: { body: string }) {
  return async (_url: unknown, init?: RequestInit) => {
    capture.body = String(init?.body);
    return new Response(JSON.stringify({ data: { player: null } }));
  };
}

describe('legacy personal-sync start.gg query is unchanged by the research ingestion path', () => {
  it("the legacy query text and variable keys match this file's recorded baseline", async () => {
    const capture = { body: '' };
    await fetchPlayerSetsPage('server-token', 1, 1, 10, capturingFetch(capture) as typeof fetch);

    const body = JSON.parse(capture.body) as { query: string; variables: Record<string, unknown> };
    expect(normalizeQuery(body.query)).toBe(normalizeQuery(EXPECTED_LEGACY_QUERY));
    expect(Object.keys(body.variables).sort()).toEqual(['page', 'perPage', 'playerId']);
  });

  it('the legacy captured query carries none of the research-only selections', async () => {
    const capture = { body: '' };
    await fetchPlayerSetsPage('server-token', 1, 1, 10, capturingFetch(capture) as typeof fetch);

    const body = JSON.parse(capture.body) as { query: string };
    for (const selection of RESEARCH_ONLY_SELECTIONS) {
      expect(body.query).not.toContain(selection);
    }
  });

  it('the research captured query carries EVERY research-only selection plus the bye/high-water filter', async () => {
    const capture = { body: '' };
    await fetchResearchSetsPage(
      'server-token',
      1,
      1,
      10,
      {},
      capturingFetch(capture) as typeof fetch,
    );

    const body = JSON.parse(capture.body) as { query: string; variables: Record<string, unknown> };
    for (const selection of RESEARCH_ONLY_SELECTIONS) {
      expect(body.query).toContain(selection);
    }
    expect(body.query).toContain('showByes: true');
    expect(body.query).toContain('$updatedAfter: Timestamp');
    expect(Object.keys(body.variables).sort()).toEqual([
      'page',
      'perPage',
      'playerId',
      'updatedAfter',
    ]);
  });

  it(
    'the research executor query carries no entrant-size argument or variable, while the ' +
      'probe-only query does (review C2-A1) — entrantSize is an UNVERIFIED provider argument ' +
      '(30-RESEARCH.md A5 / Open Question 3); GraphQL rejects a WHOLE request on an unknown ' +
      'argument, so a well-meaning consolidation that folds it into the executor query would ' +
      'convert one failed probe into a total backfill outage',
    async () => {
      const researchCapture = { body: '' };
      const probeCapture = { body: '' };

      await fetchResearchSetsPage(
        'server-token',
        1,
        1,
        10,
        {},
        capturingFetch(researchCapture) as typeof fetch,
      );
      await fetchResearchSetsProbePage(
        'server-token',
        1,
        1,
        10,
        1,
        capturingFetch(probeCapture) as typeof fetch,
      );

      const researchBody = JSON.parse(researchCapture.body) as { query: string };
      const probeBody = JSON.parse(probeCapture.body) as { query: string };

      expect(researchBody.query).not.toContain('entrantSize');
      expect(probeBody.query).toContain('entrantSize: $entrantSize');
      expect(probeBody.query).toContain('$entrantSize: Int');
    },
  );

  it("fetchPlayerSetsPage's default perPage is still 10", async () => {
    const capture = { body: '' };
    // No perPage argument passed — exercises the default.
    await fetchPlayerSetsPage(
      'server-token',
      1,
      1,
      undefined,
      capturingFetch(capture) as typeof fetch,
    );

    const body = JSON.parse(capture.body) as { variables: Record<string, unknown> };
    expect(body.variables.perPage).toBe(10);
  });
});
