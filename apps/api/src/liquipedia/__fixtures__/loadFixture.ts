import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

/**
 * Phase 30.2 Plan 02 (ENR-11): the single on-disk loader for the sanitized
 * Liquipedia fixture corpus, plus a fixture-backed `fetch` implementation
 * for injecting into code under test.
 *
 * This is the ONLY path any test in this repository may use to obtain
 * Liquipedia response bytes — see `MANIFEST.md` in this directory for the
 * provenance of every asset it reads. It performs no network I/O itself.
 *
 * Storage layout: `apps/api/src/liquipedia/__fixtures__/<name>.json` (or
 * `<name>.json.gz` for assets whose sanitized plain size exceeds 256 KB).
 * `apps/api/tsconfig.build.json` excludes this whole directory, so none of
 * it ships in the production `dist` output.
 */

/** The resolved absolute directory this module and the fixture assets live in. */
export const LIQUIPEDIA_FIXTURE_DIR = fileURLToPath(new URL('.', import.meta.url));

/** The single Liquipedia MediaWiki API endpoint every fixture route is scoped to. */
const LIQUIPEDIA_API_ENDPOINT = 'https://liquipedia.net/smash/api.php';

function fixturePath(name: string, extension: '.json' | '.json.gz'): string {
  return resolve(LIQUIPEDIA_FIXTURE_DIR, `${name}${extension}`);
}

/**
 * Reads the raw text of a named fixture, decompressing transparently when
 * only a `.json.gz` asset exists under that name. Throws — naming the
 * missing file — rather than ever returning `undefined`, so a test can never
 * silently pass against a fixture that does not exist.
 */
export function loadLiquipediaFixtureText(name: string): string {
  const plainPath = fixturePath(name, '.json');
  try {
    return readFileSync(plainPath, 'utf8');
  } catch (plainErr) {
    if (!isEnoent(plainErr)) {
      throw plainErr;
    }
  }

  const gzPath = fixturePath(name, '.json.gz');
  try {
    const compressed = readFileSync(gzPath);
    return gunzipSync(compressed).toString('utf8');
  } catch (gzErr) {
    if (isEnoent(gzErr)) {
      throw new Error(
        `Unknown Liquipedia fixture "${name}": no ${plainPath} and no ${gzPath}. ` +
          'Check the name against MANIFEST.md — a test can never fetch a fixture that ' +
          'does not exist on disk.',
        { cause: gzErr },
      );
    }
    throw gzErr;
  }
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}

/** Parses a named fixture's text as JSON. */
export function loadLiquipediaFixture<T = unknown>(name: string): T {
  return JSON.parse(loadLiquipediaFixtureText(name)) as T;
}

/** A predicate over a request URL, matched against a fixture route table. */
export type LiquipediaFixtureRouteMatch = (url: URL) => boolean;

export interface LiquipediaFixtureRoute {
  /** Decides whether this route serves a given request URL. */
  match: LiquipediaFixtureRouteMatch;
  /** The fixture name (as passed to `loadLiquipediaFixture`) to serve. */
  fixture: string;
  /** HTTP status to respond with. Defaults to 200. */
  status?: number;
  /** Extra response headers, merged over the default `content-type`. */
  headers?: Record<string, string>;
}

export interface LiquipediaFixtureFetch {
  /** Inject this as `fetchImpl` into the client under test. */
  fetchImpl: typeof fetch;
  /** Every request URL this fetch implementation has served, in order. */
  requests: URL[];
}

/**
 * Builds a fixture-backed `fetch` implementation from a route table.
 *
 * - Rejects any request whose URL is not exactly the Liquipedia API
 *   endpoint, naming the offending URL — a mistyped route can never
 *   silently egress to a different host.
 * - Rejects any request that matches no registered route, naming the URL —
 *   a test can never silently pass against a fixture it forgot to register.
 * - Records every served request onto `requests` so a test can assert
 *   request counts and ordering.
 */
export function createLiquipediaFixtureFetch(
  routes: LiquipediaFixtureRoute[],
): LiquipediaFixtureFetch {
  const requests: URL[] = [];

  const fetchImpl = (async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
    const requestUrl = toRequestUrlString(input);
    const url = new URL(requestUrl);
    const origin = `${url.origin}${url.pathname}`;
    if (origin !== LIQUIPEDIA_API_ENDPOINT) {
      throw new Error(
        `createLiquipediaFixtureFetch: refusing non-Liquipedia URL "${requestUrl}" ` +
          `(expected origin+path "${LIQUIPEDIA_API_ENDPOINT}")`,
      );
    }

    requests.push(url);

    const route = routes.find((candidate) => candidate.match(url));
    if (!route) {
      throw new Error(
        `createLiquipediaFixtureFetch: no registered fixture route matches "${requestUrl}". ` +
          'Register a route for this request, or fix the discriminator on an existing one.',
      );
    }

    const text = loadLiquipediaFixtureText(route.fixture);
    return new Response(text, {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json', ...(route.headers ?? {}) },
    });
  }) as unknown as typeof fetch;

  return { fetchImpl, requests };
}

function toRequestUrlString(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return (input as Request).url;
}

/**
 * Builds a `match` predicate asserting every named search parameter on a
 * candidate URL equals the given value, so a route table reads as data
 * rather than as a set of ad-hoc regexes.
 */
export function matchQuery(params: Record<string, string>): LiquipediaFixtureRouteMatch {
  return (url: URL) =>
    Object.entries(params).every(([key, value]) => url.searchParams.get(key) === value);
}
