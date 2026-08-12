import { loadLiquipediaFixture } from '../../../liquipedia/__fixtures__/loadFixture.js';

/**
 * Phase 30.2 Plan 12 (ENR-11): one mutation builder per synthetic case
 * RESEARCH section 10 names (S1-S5, S7, S9 — S6 is a byte-identical replay
 * needing no separate builder logic beyond "return the base unchanged," S8
 * needs no fixture bytes at all and lives entirely in the rate-limiter
 * harness).
 *
 * EVERY builder below starts from the REAL captured Supernova 2026 bracket
 * envelope (`query-supernova-2026-singles-bracket.json`, loaded through the
 * plan-02 fixture loader — the only path any test in this repository may use
 * to obtain Liquipedia response bytes) and returns a DEEP COPY with EXACTLY
 * the described mutation applied on top of it. The base bytes are otherwise
 * byte-for-byte unchanged — this is what "the synthetic builders mutate the
 * real captured fixture, so every adversarial case shares the byte-faithful
 * base" (this plan's key_link) means operationally: a builder never
 * hand-writes a bracket page from scratch, it always starts from the one the
 * corpus already proves is real.
 *
 * Every builder returns a `SyntheticMutationResult` naming exactly what it
 * changed (`description`, plus the before/after substrings where
 * applicable) so a test can assert the mutation actually landed rather than
 * trusting the builder's own claim.
 */

// ---------------------------------------------------------------------------
// Envelope shape (the exact `action=query&prop=revisions` envelope shape —
// see client.ts's `RawQueryEnvelope`/`RawPage`/`RawRevision`, duplicated
// narrowly here because this module deliberately has no dependency on
// `client.ts`'s internals, only on the on-disk fixture bytes).
// ---------------------------------------------------------------------------

export interface LiquipediaFixtureRevision {
  revid?: number;
  parentid?: number;
  timestamp?: string;
  sha1?: string;
  comment?: string;
  slots: { main: { contentmodel: string; contentformat: string; content: string } };
}

export interface LiquipediaFixturePage {
  pageid: number;
  ns: number;
  title: string;
  revisions: LiquipediaFixtureRevision[];
}

export interface LiquipediaQueryEnvelope {
  batchcomplete: boolean;
  query: {
    normalized?: { from: string; to: string; fromencoded?: boolean }[];
    pages: LiquipediaFixturePage[];
  };
}

/**
 * The mandatory ENR-11 fixture — Supernova 2026's Ultimate Singles Bracket,
 * revid 535578. Named WITHOUT the `.json` extension — `loadFixture.ts`'s
 * `loadLiquipediaFixture` appends `.json`/`.json.gz` itself.
 */
export const SUPERNOVA_BRACKET_FIXTURE_NAME = 'query-supernova-2026-singles-bracket';
/** The parent tournament page carrying the `startgg=` slug the bracket page itself does not. */
export const SUPERNOVA_TOURNAMENT_FIXTURE_NAME = 'query-supernova-2026-tournament';

export function loadSupernovaBracketEnvelope(): LiquipediaQueryEnvelope {
  return loadLiquipediaFixture<LiquipediaQueryEnvelope>(SUPERNOVA_BRACKET_FIXTURE_NAME);
}

export function loadSupernovaTournamentEnvelope(): LiquipediaQueryEnvelope {
  return loadLiquipediaFixture<LiquipediaQueryEnvelope>(SUPERNOVA_TOURNAMENT_FIXTURE_NAME);
}

function deepCloneEnvelope(envelope: LiquipediaQueryEnvelope): LiquipediaQueryEnvelope {
  return JSON.parse(JSON.stringify(envelope)) as LiquipediaQueryEnvelope;
}

export function readEnvelopeTitle(envelope: LiquipediaQueryEnvelope): string {
  return envelope.query.pages[0]!.title;
}

export function readEnvelopeRevisionId(envelope: LiquipediaQueryEnvelope): number {
  return envelope.query.pages[0]!.revisions[0]!.revid ?? 0;
}

export function readEnvelopeSha1(envelope: LiquipediaQueryEnvelope): string | null {
  return envelope.query.pages[0]!.revisions[0]!.sha1 ?? null;
}

export function readEnvelopeContent(envelope: LiquipediaQueryEnvelope): string {
  return envelope.query.pages[0]!.revisions[0]!.slots.main.content;
}

function writeEnvelopeContent(envelope: LiquipediaQueryEnvelope, content: string): void {
  envelope.query.pages[0]!.revisions[0]!.slots.main.content = content;
}

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export interface SyntheticMutationResult {
  /** Stable, human-readable case name — matches the RESEARCH section 10 label. */
  name: string;
  envelope: LiquipediaQueryEnvelope;
  /** Prose description of exactly what this builder changed relative to the base. */
  description: string;
  /** Present when the mutation is a content substring replacement — the exact text before the change (absent when the mutation is a metadata-only change, e.g. revid/sha1). */
  before?: string;
  /** Present alongside `before` — the exact text after the change. */
  after?: string;
}

function mutateContent(
  name: string,
  base: LiquipediaQueryEnvelope,
  description: string,
  mutate: (content: string) => { content: string; before: string; after: string },
): SyntheticMutationResult {
  const envelope = deepCloneEnvelope(base);
  const originalContent = readEnvelopeContent(envelope);
  const { content, before, after } = mutate(originalContent);
  if (!originalContent.includes(before)) {
    throw new Error(
      `syntheticFixtures.${name}: expected substring not found in the base fixture content — ` +
        "the base fixture bytes changed underneath this builder, or the builder's target text is stale.",
    );
  }
  writeEnvelopeContent(envelope, content);
  return { name, envelope, description, before, after };
}

// ---------------------------------------------------------------------------
// S1 — a second set between the same pair at a different round
// ---------------------------------------------------------------------------

/**
 * Appends a brand-new top-level `{{8DEWBracketA|...}}` template carrying TWO
 * set groups (`r9m1`, `r9m2`) between a fictitious rematch pair (`Sparg0` vs
 * `Kola`) — deliberately a pair that does not otherwise appear on this page,
 * so a test using this builder is never confused with the real Sparg0-vs-
 * mudd double encounter (8DEWBracketA r2m1 / DEFinalSmwBracket r2m1) already
 * present in the base fixture. Proves the "same players meeting twice"
 * property independently of that real occurrence: both sets must attach
 * distinctly, neither dropped.
 */
export function buildSecondSetAtDifferentRound(
  base: LiquipediaQueryEnvelope = loadSupernovaBracketEnvelope(),
): SyntheticMutationResult {
  const appended =
    '\n{{8DEWBracketA' +
    '|r9m1p1=Sparg0 |r9m1p1flag=mx |r9m1p1score=3' +
    '|r9m1p2=Kola |r9m1p2flag=us |r9m1p2score=0' +
    '|r9m1win=1' +
    '|r9m1date=August 8, 2026' +
    '|r9m1details={{BracketMatchDetails|vod=https://www.youtube.com/watch?v=synthS1First0}}' +
    '|r9m1p1char1=cloud |r9m1p2char1=roy |r9m1p1stock1=2 |r9m1p2stock1=0 |r9m1win1=1 |r9m1stage1=Battlefield' +
    '|r9m2p1=Sparg0 |r9m2p1flag=mx |r9m2p1score=3' +
    '|r9m2p2=Kola |r9m2p2flag=us |r9m2p2score=1' +
    '|r9m2win=1' +
    '|r9m2date=August 8, 2026' +
    '|r9m2details={{BracketMatchDetails|vod=https://www.youtube.com/watch?v=synthS1Second}}' +
    '|r9m2p1char1=cloud |r9m2p2char1=roy |r9m2p1stock1=2 |r9m2p2stock1=0 |r9m2win1=1 |r9m2stage1=Small Battlefield' +
    '}}\n';
  return mutateContent(
    'buildSecondSetAtDifferentRound',
    base,
    'appended a fictitious Sparg0-vs-Kola rematch (r9m1, r9m2) so two sets between the same pair, at different rounds, must both attach distinctly',
    (content) => ({
      content: content + appended,
      before: '</onlyinclude>',
      after: `</onlyinclude>${appended}`,
    }),
  );
}

// ---------------------------------------------------------------------------
// S2 — a set whose score conflicts with the seeded start.gg record
// ---------------------------------------------------------------------------

/**
 * Mutates the Winners-Quarterfinal set's (`8DEWBracketA r1m1`, Sparg0 vs
 * Lui$) declared `p2score` from `2` to `1` — the pair is unique on this page
 * (no duplicate Sparg0-vs-Lui$ encounter), so a resolver seeded with only
 * ONE start.gg candidate for this pair sees a SINGLETON pool before the
 * score rung, and the declared score no longer agreeing with that
 * candidate's tallied game-win pair is a stated DISAGREEMENT about a real
 * set, not an absence of one — `conflicting`, never `unmatched`.
 */
export function buildConflictingScoreMutation(
  base: LiquipediaQueryEnvelope = loadSupernovaBracketEnvelope(),
): SyntheticMutationResult {
  return mutateContent(
    'buildConflictingScoreMutation',
    base,
    "changed r1m1p2score from 2 to 1 (Sparg0 vs Lui$) so the declared score no longer agrees with the seeded provider set's tallied game-win pair",
    (content) => ({
      content: content.replace('|r1m1p2score=2', '|r1m1p2score=1'),
      before: '|r1m1p2score=2',
      after: '|r1m1p2score=1',
    }),
  );
}

// ---------------------------------------------------------------------------
// S3 — a set carrying an unknown stage string with an unrecognised form prefix
// ---------------------------------------------------------------------------

/**
 * Mutates `r1m1stage1` (Sparg0 vs Lui$, game 1) from `Battlefield` to
 * `☆ Battlefield` — `☆` (U+2606) is not one of the three known stage-form
 * prefixes (`Φ`/`Ω`/`B `), so `canonicalizeLiquipediaStage` must return
 * `stageForm: 'unknown'` and `canonicalStageId: null` even though the base
 * name after the prefix (`Battlefield`) is itself a real, mappable stage —
 * proving the unrecognised-prefix path is checked BEFORE the name lookup,
 * never silently stripped and re-mapped.
 */
export function buildUnknownStageFormMutation(
  base: LiquipediaQueryEnvelope = loadSupernovaBracketEnvelope(),
): SyntheticMutationResult {
  return mutateContent(
    'buildUnknownStageFormMutation',
    base,
    'changed r1m1stage1 from "Battlefield" to "☆ Battlefield" — an unrecognised leading stage-form symbol',
    (content) => ({
      content: content.replace('|r1m1stage1=Battlefield', '|r1m1stage1=☆ Battlefield'),
      before: '|r1m1stage1=Battlefield',
      after: '|r1m1stage1=☆ Battlefield',
    }),
  );
}

// ---------------------------------------------------------------------------
// S4 — a later revision with a bumped revision id and content sha1, and one corrected stage
// ---------------------------------------------------------------------------

/** A deterministic, obviously-synthetic sha1-shaped hex string distinct from the base fixture's real one — never derived from the real content, so it can never collide with a legitimate revision. */
export const SYNTHETIC_LATER_REVISION_SHA1 = 'f'.repeat(40);

/**
 * Bumps `revid` by 1 and replaces `sha1` with a synthetic, obviously-fake
 * value, and corrects `r1m1stage2` (Sparg0 vs Lui$, game 2) from
 * `Battlefield` to `Small Battlefield` — modelling an editor correction
 * landing on a LATER revision. A test using this builder alongside the base
 * revision proves the correction applies while every OTHER stored
 * enrichment for the page is unchanged (the page's other games, the GF/reset
 * pair, etc.).
 */
export function buildLaterRevisionCorrection(
  base: LiquipediaQueryEnvelope = loadSupernovaBracketEnvelope(),
): SyntheticMutationResult {
  const envelope = deepCloneEnvelope(base);
  const originalContent = readEnvelopeContent(envelope);
  const before = '|r1m1stage2=Battlefield';
  const after = '|r1m1stage2=Small Battlefield';
  if (!originalContent.includes(before)) {
    throw new Error('syntheticFixtures.buildLaterRevisionCorrection: expected substring not found');
  }
  writeEnvelopeContent(envelope, originalContent.replace(before, after));
  const revision = envelope.query.pages[0]!.revisions[0]!;
  const originalRevisionId = revision.revid ?? 0;
  revision.revid = originalRevisionId + 1;
  revision.sha1 = SYNTHETIC_LATER_REVISION_SHA1;
  return {
    name: 'buildLaterRevisionCorrection',
    envelope,
    description: `bumped revid from ${originalRevisionId} to ${originalRevisionId + 1}, replaced sha1 with a synthetic value, and corrected r1m1stage2 from "Battlefield" to "Small Battlefield"`,
    before,
    after,
  };
}

// ---------------------------------------------------------------------------
// S5 — a set with no date
// ---------------------------------------------------------------------------

/**
 * Removes the `r1m1date=August 9, 2026` parameter entirely from the
 * Winners-Quarterfinal set (Sparg0 vs Lui$) — round is deliberately not a
 * resolution rung (RESEARCH section 6.4), and this builder proves date's
 * absence behaves the same way: the observation still attaches on the other
 * evidence (pair + score + game count), because neither is a rung a missing
 * date can fail.
 */
export function buildMissingDateMutation(
  base: LiquipediaQueryEnvelope = loadSupernovaBracketEnvelope(),
): SyntheticMutationResult {
  return mutateContent(
    'buildMissingDateMutation',
    base,
    'removed the r1m1date parameter (Sparg0 vs Lui$) entirely',
    (content) => ({
      content: content.replace('|r1m1date=August 9, 2026\n', ''),
      before: '|r1m1date=August 9, 2026\n',
      after: '',
    }),
  );
}

// ---------------------------------------------------------------------------
// S6 — a byte-identical replay
// ---------------------------------------------------------------------------

/**
 * Returns the base fixture completely unchanged — a deep copy whose content,
 * revid and sha1 are byte-identical to the source. Exists as a named builder
 * (rather than callers reloading the fixture directly) so every synthetic
 * case in this module shares the one uniform `SyntheticMutationResult`
 * shape, and so a test can assert "no mutation landed" through the exact
 * same assertion helper it uses for every other case.
 */
export function buildByteIdenticalReplay(
  base: LiquipediaQueryEnvelope = loadSupernovaBracketEnvelope(),
): SyntheticMutationResult {
  const envelope = deepCloneEnvelope(base);
  return {
    name: 'buildByteIdenticalReplay',
    envelope,
    description: 'byte-identical deep copy of the base fixture — no content, revid or sha1 change',
  };
}

// ---------------------------------------------------------------------------
// S7 — a page matching neither family signature
// ---------------------------------------------------------------------------

/**
 * Replaces the ENTIRE content with a template that matches neither the
 * match2 signature nor the legacy signature (`detectTemplateFamily`'s
 * `'unknown'` outcome) — everything else about the envelope (pageid, title,
 * the fact that it is a real fixture-shaped response) is left alone.
 */
export function buildUnrecognisedFamilyMutation(
  base: LiquipediaQueryEnvelope = loadSupernovaBracketEnvelope(),
): SyntheticMutationResult {
  const envelope = deepCloneEnvelope(base);
  const originalContent = readEnvelopeContent(envelope);
  const replacement = '{{StatisticsPage|note=nothing bracket-shaped here}}';
  writeEnvelopeContent(envelope, replacement);
  return {
    name: 'buildUnrecognisedFamilyMutation',
    envelope,
    description:
      'replaced the entire page content with a template matching neither the match2 nor the legacy family signature',
    before: originalContent.slice(0, 40),
    after: replacement,
  };
}

// ---------------------------------------------------------------------------
// S9 — a target match seeded with a user-entered VOD URL
// ---------------------------------------------------------------------------

/** The user-entered VOD URL this fixture pairs with the byte-identical base envelope — never a Liquipedia-sourced value, so a projection run over this pairing must never overwrite it (fill-empty-only). */
export const SYNTHETIC_USER_ENTERED_VOD_URL = 'https://www.youtube.com/watch?v=userEnteredVod001';

/**
 * The base envelope is NOT mutated for this case — the adversarial
 * condition this fixture models lives on the MATCH ROW (a pre-existing,
 * user-typed VOD URL), not on the Liquipedia source bytes. Returned in the
 * same `SyntheticMutationResult` shape as every other builder so a caller
 * can still deep-copy and drive the pipeline uniformly; `description` states
 * plainly that the "mutation" is the paired user-entered URL constant, not a
 * content change.
 */
export function buildUserVodSeedFixture(
  base: LiquipediaQueryEnvelope = loadSupernovaBracketEnvelope(),
): SyntheticMutationResult & { userVodUrl: string } {
  const envelope = deepCloneEnvelope(base);
  return {
    name: 'buildUserVodSeedFixture',
    envelope,
    description:
      `paired the byte-identical base envelope with a user-entered VOD URL (${SYNTHETIC_USER_ENTERED_VOD_URL}) ` +
      'seeded directly on a match row — the mutation under test is row ownership, not source content',
    userVodUrl: SYNTHETIC_USER_ENTERED_VOD_URL,
  };
}

// ---------------------------------------------------------------------------
// Every builder, for a test to iterate ("every builder has at least one
// assertion proving its mutation landed").
// ---------------------------------------------------------------------------

export const ALL_SYNTHETIC_FIXTURE_BUILDERS = [
  buildSecondSetAtDifferentRound,
  buildConflictingScoreMutation,
  buildUnknownStageFormMutation,
  buildLaterRevisionCorrection,
  buildMissingDateMutation,
  buildByteIdenticalReplay,
  buildUnrecognisedFamilyMutation,
  buildUserVodSeedFixture,
] as const;
