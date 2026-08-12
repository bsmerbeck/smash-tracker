import type { LiquipediaConfig } from '../config/env.js';
import type { LiquipediaLimiter } from './limiter.js';
import { resolveBackoffDelayMs } from '../research/ingestion/backoff.js';

/**
 * Phase 30.2 Plan 03 (ENR-01, ENR-09): the Liquipedia MediaWiki API
 * transport. Every published term of https://liquipedia.net/api-terms-of-use
 * is an ENFORCED STRUCTURAL PROPERTY here, not a convention a caller can
 * forget — see the review notes at each relevant declaration below.
 *
 * Connection reuse (cycle-1 review MEDIUM 9): this module constructs NO
 * agent or dispatcher of any kind and imports NO `undici`. Node 24's global
 * `fetch` is undici-backed and its built-in global dispatcher already pools
 * and reuses HTTP connections; there is no keep-alive `Agent` reachable
 * without adding `undici` as a direct dependency (it is not one —
 * `apps/api/package.json` gains none from this plan). This module also does
 * NOT set a `Connection` header — the Fetch specification forbids it as a
 * "forbidden request header name" and a caller-set value would be silently
 * dropped by the runtime, making it worse than a no-op to write. The
 * corollary of the required `fetchImpl` below is that connection management
 * is a property of the INJECTED transport, owned by the caller (the single
 * production composition root supplies `globalThis.fetch` explicitly), not
 * of this module — so a future reader should not re-add a dependency to
 * solve a problem the runtime already solves.
 */

/** The single, constant Liquipedia MediaWiki API endpoint. No method in this module accepts a URL, host, or path from caller input or from fetched content — see `buildRequestUrl` below. */
export const LIQUIPEDIA_API_ENDPOINT = 'https://liquipedia.net/smash/api.php';

/** Base URL for constructing human-readable attribution links (ENR-09), derived mechanically from the `articlepath` field reported by `meta=siteinfo`. */
export const LIQUIPEDIA_ARTICLE_BASE_URL = 'https://liquipedia.net/smash/';

/**
 * The largest legitimate response observed during research was 1.4 MB
 * (`30.2-RESEARCH.md` §15); 10 MiB is generous headroom against a
 * decompression-bomb / oversized-body DoS (T-30.2-12) while never rejecting
 * real Liquipedia content. `maxarticlesize` (the wiki's own page-size cap)
 * is 4 MiB, so this cap is intentionally larger than any single page could
 * ever be even before JSON-envelope overhead.
 */
export const LIQUIPEDIA_MAX_RESPONSE_BYTES = 10_485_760;

/** `titles` accepts up to 50 pipe-separated titles per `action=query` request for anonymous clients (`30.2-RESEARCH.md` §1.2). */
export const LIQUIPEDIA_MAX_TITLES_PER_REQUEST = 50;

/**
 * Cap on the non-2xx response body excerpt captured onto
 * `LiquipediaApiError.responseBody`, mirroring `STARTGG_ERROR_BODY_EXCERPT_MAX`
 * in `apps/api/src/startgg/client.ts` — bounded so an unexpected HTML error
 * page can never bloat a log line or an error object.
 */
export const LIQUIPEDIA_ERROR_BODY_EXCERPT_MAX = 1000;

/**
 * The tested parse-class page allowlist (owner CONTEXT: "genuinely
 * required" must be falsifiable). Exactly ONE entry: a top-level page title
 * whose final path segment is `VODs` — the only page family whose wikitext
 * source is confirmed useless (`30.2-RESEARCH.md` §5.1) and whose content is
 * genuinely generator-only (`{{Player vod list}}`). Anchored on both ends so
 * a substring match can never silently widen the allowlist.
 */
export const LIQUIPEDIA_PARSE_CLASS_ALLOWLIST: RegExp[] = [/^[^/]+\/VODs$/];

/** Whether `title` may be the target of a parse-class request (`action=parse` or `action=expandtemplates`). Checked BEFORE the limiter is consulted and before any fetch occurs (T-30.2-15). */
export function isParseClassPageAllowed(title: string): boolean {
  return LIQUIPEDIA_PARSE_CLASS_ALLOWLIST.some((pattern) => pattern.test(title));
}

/** Turns a Liquipedia page title into its human-readable article URL, replacing spaces with underscores (the wiki's own `articlepath` convention — `30.2-RESEARCH.md` §1.1). */
export function buildLiquipediaPageUrl(title: string): string {
  return `${LIQUIPEDIA_ARTICLE_BASE_URL}${title.replace(/ /g, '_')}`;
}

/** Mirrors `StartggApiError` in `apps/api/src/startgg/client.ts`: a non-2xx response, carrying the retry-after header value (if any) and a bounded body excerpt. */
export class LiquipediaApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfter?: string,
    readonly responseBody?: string,
  ) {
    super(message);
    this.name = 'LiquipediaApiError';
  }
}

/** Thrown when a parse-class request targets a page not on `LIQUIPEDIA_PARSE_CLASS_ALLOWLIST`. Thrown before the limiter is consulted and before any fetch occurs. */
export class LiquipediaParseNotAllowedError extends Error {
  constructor(readonly title: string) {
    super(`Liquipedia parse-class request refused: "${title}" is not on the tested allowlist`);
    this.name = 'LiquipediaParseNotAllowedError';
  }
}

/** Thrown when a response body exceeds `LIQUIPEDIA_MAX_RESPONSE_BYTES`, before it is parsed. */
export class LiquipediaResponseTooLargeError extends Error {
  constructor(readonly byteLimit: number) {
    super(`Liquipedia response body exceeded the ${byteLimit}-byte cap`);
    this.name = 'LiquipediaResponseTooLargeError';
  }
}

/** Delegates to the shared `resolveBackoffDelayMs` (`apps/api/src/research/ingestion/backoff.ts`) rather than reimplementing backoff — deterministic, finite, non-negative, clamped. */
export function resolveLiquipediaRetryDelayMs(error: LiquipediaApiError, attempt: number): number {
  return resolveBackoffDelayMs(error.retryAfter, attempt);
}

// ---- request-target construction (T-30.2-11: host/path are constants) ----

function buildRequestUrl(params: Record<string, string>): URL {
  const url = new URL(LIQUIPEDIA_API_ENDPOINT);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url;
}

// ---- defensive, size-capped body read (T-30.2-12) -------------------------

/**
 * Reads a response body capped at `maxBytes`, throwing
 * `LiquipediaResponseTooLargeError` PAST the cap without ever buffering more
 * than `maxBytes` (plus one final chunk) into memory. Falls back to a
 * post-hoc `text()` check on runtimes where `response.body` is unavailable
 * (never expected against Node 24's global `fetch`, but defensive).
 */
async function readCappedResponseBody(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new LiquipediaResponseTooLargeError(maxBytes);
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new LiquipediaResponseTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

// ---- envelope shapes --------------------------------------------------

interface RawRevision {
  revid?: number;
  timestamp?: string;
  sha1?: string;
  size?: number;
  slots?: { main?: { content?: string } };
}

interface RawPage {
  pageid?: number;
  title: string;
  missing?: boolean;
  revisions?: RawRevision[];
}

interface RawQueryEnvelope {
  query?: {
    normalized?: { from: string; to: string }[];
    redirects?: { from: string; to: string }[];
    pages?: RawPage[];
    allpages?: { pageid: number; title: string }[];
    general?: Record<string, unknown>;
  };
  continue?: Record<string, string>;
}

export type LiquipediaPageRevisionResult =
  | { present: false; title: string }
  | {
      present: true;
      pageId?: number;
      title: string;
      revisionId?: number;
      sha1?: string;
      size?: number;
      timestamp?: string;
      content?: string;
    };

export interface LiquipediaRevisionQueryResult {
  pages: LiquipediaPageRevisionResult[];
  normalized: { from: string; to: string }[];
  redirects: { from: string; to: string }[];
}

export type LiquipediaGeneratedPageMode = 'expandtemplates' | 'parse';

export interface LiquipediaGeneratedPageResult {
  title: string;
  pageId?: number;
  revisionId?: number;
  mode: LiquipediaGeneratedPageMode;
  content: string;
}

export interface LiquipediaSiteInfo {
  sitename?: string;
  base?: string;
  generator?: string;
  articlepath?: string;
  server?: string;
  timezone?: string;
  timeoffset?: number;
  maxarticlesize?: number;
}

export interface CreateLiquipediaClientOptions {
  config: LiquipediaConfig;
  limiter: LiquipediaLimiter;
  /**
   * REQUIRED, not optional-with-a-default. This deliberately deviates from
   * `apps/api/src/startgg/client.ts`'s convention of a trailing fetch-typed
   * parameter that falls back to the runtime's own implementation when the
   * caller omits it (cycle-1 review HIGH 4): a default-fetch path makes the
   * phase's no-network guarantee depend on every future test remembering to
   * inject one, and a test that forgets would reach the REAL liquipedia.net
   * and still pass — violating both
   * ENR-11 and the owner's locked access contract. Removing the default
   * makes the unsafe path UNREACHABLE BY CONSTRUCTION rather than merely
   * discouraged. The single production composition root supplies
   * `globalThis.fetch` explicitly, so runtime behavior is unchanged and the
   * choice is visible exactly where it is made.
   */
  fetchImpl: typeof fetch;
  now?: () => number;
  userAgentVersion?: string;
}

export interface LiquipediaClient {
  getSiteInfo(): Promise<LiquipediaSiteInfo>;
  headRevisions(titles: string[]): Promise<LiquipediaRevisionQueryResult>;
  getWikitext(titles: string[]): Promise<LiquipediaRevisionQueryResult>;
  listSubpages(
    prefix: string,
    options?: { maxContinuations?: number },
  ): Promise<{ title: string; pageId: number }[]>;
  getGeneratedVodPage(
    title: string,
    options?: { mode?: LiquipediaGeneratedPageMode },
  ): Promise<LiquipediaGeneratedPageResult>;
}

const DEFAULT_USER_AGENT_VERSION = '1.0';

/** Bounds an unbounded `list=allpages` continuation walk (`30.2-RESEARCH.md` §8.7) — no traversal in this module ever loops without a ceiling. */
const DEFAULT_MAX_CONTINUATIONS = 10;

/**
 * The per-call remaining-wait-budget passed to `LiquipediaLimiter.acquire`.
 * Generous relative to the worst-case published interval (30s) so a normal
 * call never spuriously fails to acquire, while still bounded (never
 * `Infinity`) so a pathological retry storm cannot hang a caller forever.
 */
const DEFAULT_ACQUIRE_WAIT_BUDGET_MS = 60_000;

/**
 * Creates the Liquipedia MediaWiki API client. Throws BEFORE any request is
 * attempted when `options.config` is falsy-shaped incorrectly (callers are
 * expected to pass the result of `getLiquipediaConfig`, which is already
 * null-checked — this constructor's own guard exists so a caller can never
 * construct a client around a config object with an empty contact string
 * either).
 */
export function createLiquipediaClient(options: CreateLiquipediaClientOptions): LiquipediaClient {
  const { config, limiter, fetchImpl } = options;
  const userAgentVersion = options.userAgentVersion ?? DEFAULT_USER_AGENT_VERSION;

  if (!config || !config.contact) {
    throw new Error(
      'Liquipedia client construction refused: no contact identifier configured (set LIQUIPEDIA_CONTACT). ' +
        'The published API terms of use require an identifying contact on every request.',
    );
  }

  // Owner-approved shape (decision 2026-08-11): the contact segment
  // interpolates the configured `LIQUIPEDIA_CONTACT`; the rest is constant.
  const userAgent = `grandfinals.gg-liquipedia-enrichment/${userAgentVersion} (https://grandfinals.gg; ${config.contact})`;

  /**
   * Acquires the given budget class or throws — the limiter's `granted`
   * result is NOT advisory. A caller that ignored a non-granted result and
   * fetched anyway would defeat the entire structural point of ENR-01's
   * durable limiter (the enforced property would degrade back into a
   * convention nothing checks).
   */
  async function acquireOrThrow(requestClass: Parameters<LiquipediaLimiter['acquire']>[0]) {
    const result = await limiter.acquire(requestClass, DEFAULT_ACQUIRE_WAIT_BUDGET_MS);
    if (!result.granted) {
      throw new Error(
        `Liquipedia request refused: the ${requestClass} rate-limit budget was not granted ` +
          `within ${DEFAULT_ACQUIRE_WAIT_BUDGET_MS}ms (reason: ${result.reason ?? 'unknown'})`,
      );
    }
  }

  async function issueRequest(url: URL): Promise<unknown> {
    const response = await fetchImpl(url, {
      headers: {
        'User-Agent': userAgent,
        'Accept-Encoding': 'gzip',
      },
    });

    // Capture retry-after BEFORE touching the body (defensive read order).
    const retryAfter = response.headers.get('retry-after') ?? undefined;

    if (!response.ok) {
      let excerpt: string | undefined;
      try {
        const text = await readCappedResponseBody(response, LIQUIPEDIA_MAX_RESPONSE_BYTES);
        excerpt = text.slice(0, LIQUIPEDIA_ERROR_BODY_EXCERPT_MAX);
      } catch (err) {
        if (err instanceof LiquipediaResponseTooLargeError) {
          // The size cap is a distinct failure mode from a body-read
          // failure and must propagate as its own error class, not be
          // degraded into an excerpt-less LiquipediaApiError.
          throw err;
        }
        // A rejecting body read (e.g. an already-consumed or transport-
        // level-failed body) degrades to an undefined excerpt WITHOUT
        // changing the error class — mirrors `startgg/client.ts`'s `gql()`.
        excerpt = undefined;
      }
      throw new LiquipediaApiError(
        `Liquipedia API returned ${response.status}`,
        response.status,
        retryAfter,
        excerpt,
      );
    }

    const text = await readCappedResponseBody(response, LIQUIPEDIA_MAX_RESPONSE_BYTES);
    return JSON.parse(text);
  }

  function normalizeQueryResult(envelope: RawQueryEnvelope, includeContent: boolean) {
    const rawPages = envelope.query?.pages ?? [];
    const pages: LiquipediaPageRevisionResult[] = rawPages.map((page) => {
      if (page.missing || !page.revisions || page.revisions.length === 0) {
        return { present: false, title: page.title };
      }
      const revision = page.revisions[0]!;
      return {
        present: true,
        pageId: page.pageid,
        title: page.title,
        revisionId: revision.revid,
        sha1: revision.sha1,
        size: revision.size,
        timestamp: revision.timestamp,
        content: includeContent ? revision.slots?.main?.content : undefined,
      };
    });
    return {
      pages,
      normalized: envelope.query?.normalized ?? [],
      redirects: envelope.query?.redirects ?? [],
    };
  }

  function validateTitleBatch(titles: string[]): void {
    if (titles.length > LIQUIPEDIA_MAX_TITLES_PER_REQUEST) {
      throw new Error(
        `Liquipedia request refused: ${titles.length} titles exceeds the ` +
          `${LIQUIPEDIA_MAX_TITLES_PER_REQUEST}-title-per-request limit`,
      );
    }
  }

  async function queryRevisions(
    titles: string[],
    includeContent: boolean,
  ): Promise<LiquipediaRevisionQueryResult> {
    validateTitleBatch(titles);

    const rvprop = includeContent ? 'content|ids|timestamp|sha1|size' : 'ids|timestamp|sha1|size';
    const url = buildRequestUrl({
      action: 'query',
      prop: 'revisions',
      rvprop,
      rvslots: 'main',
      titles: titles.join('|'),
      redirects: '1',
      format: 'json',
      formatversion: '2',
    });

    await acquireOrThrow('general');
    const envelope = (await issueRequest(url)) as RawQueryEnvelope;
    return normalizeQueryResult(envelope, includeContent);
  }

  return {
    async getSiteInfo(): Promise<LiquipediaSiteInfo> {
      const url = buildRequestUrl({
        action: 'query',
        meta: 'siteinfo',
        siprop: 'general',
        format: 'json',
        formatversion: '2',
      });
      await acquireOrThrow('general');
      const envelope = (await issueRequest(url)) as RawQueryEnvelope;
      return (envelope.query?.general ?? {}) as LiquipediaSiteInfo;
    },

    async headRevisions(titles: string[]): Promise<LiquipediaRevisionQueryResult> {
      return queryRevisions(titles, false);
    },

    async getWikitext(titles: string[]): Promise<LiquipediaRevisionQueryResult> {
      return queryRevisions(titles, true);
    },

    async listSubpages(
      prefix: string,
      listOptions?: { maxContinuations?: number },
    ): Promise<{ title: string; pageId: number }[]> {
      const maxContinuations = listOptions?.maxContinuations ?? DEFAULT_MAX_CONTINUATIONS;
      const results: { title: string; pageId: number }[] = [];
      let continuation: Record<string, string> | undefined;
      let iterations = 0;

      for (;;) {
        const url = buildRequestUrl({
          action: 'query',
          list: 'allpages',
          apnamespace: '0',
          apprefix: prefix,
          format: 'json',
          formatversion: '2',
          ...(continuation ?? {}),
        });
        await acquireOrThrow('general');
        const envelope = (await issueRequest(url)) as RawQueryEnvelope;
        for (const page of envelope.query?.allpages ?? []) {
          results.push({ title: page.title, pageId: page.pageid });
        }
        if (!envelope.continue) {
          break;
        }
        iterations += 1;
        if (iterations >= maxContinuations) {
          break;
        }
        continuation = envelope.continue;
      }

      return results;
    },

    async getGeneratedVodPage(
      title: string,
      genOptions?: { mode?: LiquipediaGeneratedPageMode },
    ): Promise<LiquipediaGeneratedPageResult> {
      // The allowlist is consulted BEFORE the limiter and before any fetch
      // (T-30.2-15) — a disallowed title costs no budget and reaches no
      // network.
      if (!isParseClassPageAllowed(title)) {
        throw new LiquipediaParseNotAllowedError(title);
      }

      // BOTH modes are parse-class (module header + plan Task 2 action):
      // `action=expandtemplates` on `{{Player vod list}}` triggers the
      // identical server-side Lua + LiquipediaDB work as `action=parse`, so
      // it is deliberately throttled as parse-class even though the
      // published terms name only the rendered-parse action. Routing
      // around a documented limit on a technicality is inconsistent with
      // the owner's locked "every item is an enforced property" stance —
      // the legitimate benefit taken here is the output shape (unresolved
      // wikilinks vs. rendered HTML), never the quota.
      const mode = genOptions?.mode ?? 'expandtemplates';
      await acquireOrThrow('parse-class');

      if (mode === 'expandtemplates') {
        const url = buildRequestUrl({
          action: 'expandtemplates',
          title,
          text: '{{Player vod list}}',
          prop: 'wikitext',
          format: 'json',
          formatversion: '2',
        });
        const envelope = (await issueRequest(url)) as {
          expandtemplates?: { wikitext?: string };
        };
        return {
          title,
          mode,
          content: envelope.expandtemplates?.wikitext ?? '',
        };
      }

      const url = buildRequestUrl({
        action: 'parse',
        page: title,
        prop: 'text|revid|displaytitle',
        format: 'json',
        formatversion: '2',
      });
      const envelope = (await issueRequest(url)) as {
        parse?: { title?: string; pageid?: number; revid?: number; text?: string };
      };
      return {
        title: envelope.parse?.title ?? title,
        pageId: envelope.parse?.pageid,
        revisionId: envelope.parse?.revid,
        mode,
        content: envelope.parse?.text ?? '',
      };
    },
  };
}
