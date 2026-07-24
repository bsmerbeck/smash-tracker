import escapeHtml from 'escape-html';
import { formatOrdinal, getFighterById, type PublicShareSnapshot } from '@smash-tracker/shared';
import { createTtlCache } from './ttlCache.js';

/**
 * IN-06 fix: this no longer bounds shell freshness — every `/s/:token`
 * request revalidates `spa.html` against the Hosting origin via a
 * conditional GET (`If-None-Match`/ETag), so a hosting deploy is picked up
 * on the very next request instead of waiting out a TTL. This constant now
 * bounds only how long a last-good cached shell may keep being served
 * stale-on-error when the Hosting origin's `spa.html` can't be reached
 * (network error, non-2xx, or an unexpected bare 304).
 */
const SHELL_CACHE_TTL_MS = 5 * 60 * 1000;
const SHELL_CACHE_KEY = 'spa-shell';

/** In-memory shell cache entry: the last-fetched shell body plus its ETag (if the origin sent one), used to build the next request's `If-None-Match`. */
interface ShellCacheEntry {
  html: string;
  etag?: string;
}

// Module-level: one Fastify process serves every request, so one shell cache
// (there is only ever one shell) suffices — see ttlCache.ts's module doc for
// why this is a plain in-memory Map, not an RTDB-backed cache.
const shellCache = createTtlCache<ShellCacheEntry>(SHELL_CACHE_TTL_MS);

/**
 * Test-only seam: clears the module-level shell cache. Without it, the first
 * successful test in a file populates the cache and every later
 * shell-fetch-FAILURE test silently exercises the cached happy path instead
 * of the fallback it claims to cover. Never called by production code.
 */
export function resetShareHtmlCachesForTests(): void {
  shellCache.clear();
}

const FALLBACK_TITLE = 'Shared VOD review · grandfinals.gg';
const FALLBACK_DESCRIPTION =
  'Watch a shared VOD review with click-to-seek timestamps on grandfinals.gg.';

export interface RenderShareHtmlOptions {
  token: string;
  /** The public, redacted snapshot (from `RtdbService.getShareByToken`), or `null` for an unknown/revoked/malformed token. */
  snapshot: PublicShareSnapshot | null;
  /** SPA origin to fetch `spa.html` from and to build the canonical/og:url against (`env.WEB_BASE_URL`). */
  webBaseUrl: string;
  /** Overridable fetch (tests). Defaults to global fetch — mirrors GspLiveService's fetchImpl pattern. */
  fetchImpl?: typeof fetch;
}

interface ShareMeta {
  title: string;
  description: string;
  canonicalUrl: string;
  /**
   * The per-token generated OG card (`/s/:token/og.png`) for an ACTIVE
   * snapshot; `null` for an unknown/revoked/malformed token, which leaves
   * the shell's static `og-image.png` untouched — the generic image never
   * discloses whether a token ever referred to a real share (VIEW-05).
   */
  ogImageUrl: string | null;
}

/**
 * Phase 6 (Anonymous Share Experience & Discord Unfurls): renders the
 * always-200 `GET /s/:token` HTML response. Fetches the SPA's own pristine
 * `spa.html` shell from the Hosting static origin — NOT through `/s/:token`
 * itself, which would recurse through the same Hosting rewrite — then
 * string-swaps ONLY the 7 head tags `useSeo.ts`
 * already manages client-side (og:title, twitter:title, description,
 * og:description, twitter:description, canonical, og:url), plus — for an
 * ACTIVE snapshot only — `og:image`/`twitter:image` (pointed at the
 * generated per-token card `/s/:token/og.png`), plus always sets
 * `robots: noindex` (unlisted means unlisted, VIEW-05). Every other static
 * head tag (viewport, favicon, theme-color, etc.) is left untouched.
 *
 * OG content is derived ONLY from the public, redacted snapshot — never
 * note/tag text (OG-02, T-06-02). The owner display name is appended to the
 * description ONLY when `redaction.showDisplayName` is true, and is
 * HTML-escaped first (T-06-03) since it lands inside a `content="..."`
 * attribute value in a raw string-replace pipeline (not a DOM API), so an
 * unescaped `"` could break out of the attribute.
 *
 * A `null` snapshot (unknown/revoked/malformed token) renders generic,
 * non-leaking meta — no fighter/stage/date/count detail — so meta never
 * discloses whether a token ever referred to a real share (VIEW-05).
 *
 * IN-06: the shell is revalidated against the Hosting origin on EVERY
 * request via a conditional GET (`If-None-Match` against the last-seen
 * ETag) — a `304` reuses the cached body cheaply, a fresh `2xx` picks up a
 * hosting deploy immediately (never a stale bundle reference), and if the
 * origin can't be reached or errors, the last-good cached shell is served
 * stale rather than degrading straight to the fallback template (see
 * `getShell`). Only a COLD cache (nothing cached yet) combined with a
 * fetch failure falls through to the hardcoded minimal fallback template
 * below, so a Hosting-origin hiccup never turns into a 500 on the
 * crawler/human path.
 */
export async function renderShareHtml({
  token,
  snapshot,
  webBaseUrl,
  fetchImpl = fetch,
}: RenderShareHtmlOptions): Promise<string> {
  const meta = computeMeta(snapshot, token, webBaseUrl);

  let shell: string;
  try {
    shell = await getShell(webBaseUrl, fetchImpl);
  } catch (err) {
    // Log-and-degrade, never throw (the crawler path must not 500) — but a
    // silent degrade would make a Hosting-origin outage invisible in Cloud
    // Run logs. console.error because this module-level helper has no
    // request-scoped Fastify logger.
    console.error('share HTML shell fetch failed, serving fallback template', err);
    return fallbackHtml(meta, webBaseUrl);
  }

  return applyMeta(shell, meta);
}

/**
 * IN-06: conditionally revalidates the cached shell against the Hosting
 * origin on every call instead of trusting a TTL — a stale-deploy shell is
 * otherwise served for up to `SHELL_CACHE_TTL_MS` after every hosting
 * deploy, breaking every `/s/:token` page until it expires (reproduced
 * live 2026-07-24). `SHELL_CACHE_TTL_MS` now only bounds how long a
 * last-good cached shell may keep serving stale when the origin is
 * unreachable/erroring.
 */
async function getShell(webBaseUrl: string, fetchImpl: typeof fetch): Promise<string> {
  const cached = shellCache.get(SHELL_CACHE_KEY);

  let response: Response;
  try {
    response = await fetchImpl(
      `${webBaseUrl}/spa.html`,
      cached?.etag ? { headers: { 'If-None-Match': cached.etag } } : undefined,
    );
  } catch (err) {
    // Fetch itself threw (e.g. network error) — serve the last-good cached
    // shell rather than degrading all the way to the bare fallback
    // template, but only if we have one to serve.
    if (cached !== undefined) {
      console.error('share HTML shell revalidation fetch failed, serving stale cached shell', err);
      return cached.html;
    }
    throw err;
  }

  if (response.status === 304) {
    if (cached !== undefined) {
      // Refresh the TTL on the still-valid cached entry so a run of 304s
      // keeps extending how long it may be served stale-on-error later.
      shellCache.set(SHELL_CACHE_KEY, cached);
      return cached.html;
    }
    // A bare 304 with nothing cached to revalidate against should never
    // happen (we only send If-None-Match when a cached entry exists), but
    // guard defensively rather than returning `undefined` as html.
    throw new Error('spa.html fetch failed: received 304 with no cached shell to revalidate');
  }

  if (!response.ok) {
    if (cached !== undefined) {
      console.error(
        `share HTML shell revalidation failed (status ${response.status}), serving stale cached shell`,
      );
      return cached.html;
    }
    throw new Error(`spa.html fetch failed: ${response.status}`);
  }

  const html = await response.text();
  const etag = response.headers?.get?.('etag') ?? undefined;
  shellCache.set(SHELL_CACHE_KEY, { html, ...(etag ? { etag } : {}) });
  return html;
}

function computeMeta(
  snapshot: PublicShareSnapshot | null,
  token: string,
  webBaseUrl: string,
): ShareMeta {
  const canonicalUrl = `${webBaseUrl}/s/${token}`;

  // Unknown/revoked/malformed token FIRST, before any kind branch — meta
  // must never disclose whether a token ever referred to a real share
  // (VIEW-05's no-oracle discipline).
  if (!snapshot) {
    // ogImageUrl stays null — the shell's static og-image.png remains, so a
    // crawler is never pointed at a per-token card URL for a token that may
    // not exist (VIEW-05).
    return {
      title: FALLBACK_TITLE,
      description: FALLBACK_DESCRIPTION,
      canonicalUrl,
      ogImageUrl: null,
    };
  }

  if (snapshot.kind === 'recap') {
    return computeRecapMeta(snapshot, token, webBaseUrl);
  }

  const fighterAName = getFighterById(snapshot.fighterId!)?.name ?? 'Unknown fighter';
  const fighterBName = getFighterById(snapshot.opponentFighterId!)?.name ?? 'Unknown fighter';
  // Stage id 0 is the "no selection" sentinel (shared stageData) — omit the
  // stage segment rather than rendering the literal "no selection" in meta.
  const stageLabel = snapshot.stage && snapshot.stage.id !== 0 ? snapshot.stage.name : undefined;
  const matchDateLabel = new Date(snapshot.matchDate!).toLocaleDateString('en-US');

  const title = `${fighterAName} vs ${fighterBName} — VOD review · grandfinals.gg`;
  let description =
    `${snapshot.reviewedMomentsCount} timestamped moments` +
    (stageLabel ? ` · ${stageLabel}` : '') +
    ` · ${matchDateLabel}. Watch with click-to-seek timestamps.`;

  // Owner display name only when the owner opted in AND a name was actually
  // captured on the snapshot (OG-02). Escaping happens once, in
  // `replaceMetaTag`/`fallbackHtml` (whichever renders this string into a
  // `content="..."` attribute) — do NOT escape here too, or the escaping
  // itself would double-encode (T-06-03).
  if (snapshot.redaction!.showDisplayName && snapshot.ownerDisplayName) {
    description += ` Shared by ${snapshot.ownerDisplayName}.`;
  }

  // Active snapshot: point crawlers at the generated per-token OG card —
  // this rewrite is what makes the satori/resvg pipeline reachable at all
  // (without it every unfurl shows the generic static og-image.png).
  const ogImageUrl = `${webBaseUrl}/s/${token}/og.png`;

  return { title, description, canonicalUrl, ogImageUrl };
}

/**
 * Phase 7 (Recap Cards & Share-Loop Analytics): meta copy for a `kind:
 * 'recap'` snapshot — derived ONLY from the deterministic card stats
 * (`publicShareSnapshotSchema`'s `.refine()` guarantees `tournamentName`,
 * `tournamentDate`, the set record, and `characterFighterIds` are present
 * whenever `kind === 'recap'`, even though the flat/refine schema can't
 * express that as a TypeScript-narrowed type — see 07-03-SUMMARY.md). Every
 * fragment (seed→finish, reviewed-moments) is omitted gracefully when the
 * source data is absent/zero, per CONTEXT.md's deterministic-rules
 * ("zero reviewed moments: omit the line", "missing seed data: omit the
 * seed→finish line gracefully"). `tournamentName` is free text sourced from
 * start.gg/parry.gg (same trust tier as `ownerDisplayName`) — it is escaped
 * exactly once, inside `replaceMetaTag`/`fallbackHtml` when this string is
 * written into a `content="..."` attribute, matching the discipline already
 * documented on the vod-review branch above (do NOT escape here too).
 */
function computeRecapMeta(
  snapshot: PublicShareSnapshot,
  token: string,
  webBaseUrl: string,
): ShareMeta {
  const canonicalUrl = `${webBaseUrl}/s/${token}`;

  const placementPrefix =
    snapshot.placement != null ? `${formatOrdinal(snapshot.placement)} at ` : '';
  const title = `${placementPrefix}${snapshot.tournamentName} — recap · grandfinals.gg`;

  const wins = snapshot.setRecordWins ?? 0;
  const losses = snapshot.setRecordLosses ?? 0;
  const descriptionParts = [`${wins}–${losses} set record`];
  if (snapshot.seed != null && snapshot.placement != null) {
    descriptionParts.push(`seed ${snapshot.seed} → ${formatOrdinal(snapshot.placement)} finish`);
  }
  if (snapshot.reviewedMomentsCount > 0) {
    descriptionParts.push(`${snapshot.reviewedMomentsCount} reviewed moments`);
  }
  const description = `${descriptionParts.join(' · ')}. Watch the recap on grandfinals.gg.`;

  // Recap tokens always point at the per-token generated card — the recap
  // card's whole purpose is to be shared/unfurled/downloaded (RECAP-03).
  const ogImageUrl = `${webBaseUrl}/s/${token}/og.png`;

  return { title, description, canonicalUrl, ogImageUrl };
}

function applyMeta(html: string, meta: ShareMeta): string {
  let out = html;
  out = replaceMetaTag(out, 'property', 'og:title', meta.title);
  out = replaceMetaTag(out, 'name', 'twitter:title', meta.title);
  out = replaceMetaTag(out, 'name', 'description', meta.description);
  out = replaceMetaTag(out, 'property', 'og:description', meta.description);
  out = replaceMetaTag(out, 'name', 'twitter:description', meta.description);
  out = replaceLinkHref(out, 'canonical', meta.canonicalUrl);
  out = replaceMetaTag(out, 'property', 'og:url', meta.canonicalUrl);
  // Only for an active snapshot — a null ogImageUrl keeps the shell's
  // generic static image (unknown/revoked tokens must not hint at validity).
  if (meta.ogImageUrl) {
    out = replaceMetaTag(out, 'property', 'og:image', meta.ogImageUrl);
    out = replaceMetaTag(out, 'name', 'twitter:image', meta.ogImageUrl);
  }
  out = setRobotsNoindex(out);
  return out;
}

/** Replaces (or, if absent, inserts) `content="..."` on the `<meta>` tag identified by `selectorAttr="selectorValue"`. */
function replaceMetaTag(
  html: string,
  selectorAttr: 'name' | 'property',
  selectorValue: string,
  contentValue: string,
): string {
  const escapedValue = escapeHtml(contentValue);
  const tagRegex = new RegExp(`<meta[^>]*${selectorAttr}="${selectorValue}"[^>]*>`, 'i');
  if (!tagRegex.test(html)) return html;

  // Replacer FUNCTIONS (never replacement strings) so `$&`/`$\``/`$'`/`$$`
  // in user-derived content (owner display name, token) stay inert —
  // String.replace treats `$`-patterns in a replacement STRING specially,
  // which would corrupt the emitted tag (escapeHtml does not touch `$`).
  return html.replace(tagRegex, (tag) => {
    if (/content="[^"]*"/i.test(tag)) {
      return tag.replace(/content="[^"]*"/i, () => `content="${escapedValue}"`);
    }
    return tag.replace(/\/?>$/, (closer) => ` content="${escapedValue}"${closer}`);
  });
}

/** Replaces (or, if absent, inserts) `href="..."` on the `<link>` tag identified by `rel="relValue"`. */
function replaceLinkHref(html: string, relValue: string, hrefValue: string): string {
  const escapedValue = escapeHtml(hrefValue);
  const tagRegex = new RegExp(`<link[^>]*rel="${relValue}"[^>]*>`, 'i');
  if (!tagRegex.test(html)) return html;

  // Replacer functions for the same `$`-pattern reason as replaceMetaTag —
  // the URL token flows into this value.
  return html.replace(tagRegex, (tag) => {
    if (/href="[^"]*"/i.test(tag)) {
      return tag.replace(/href="[^"]*"/i, () => `href="${escapedValue}"`);
    }
    return tag.replace(/\/?>$/, (closer) => ` href="${escapedValue}"${closer}`);
  });
}

/** Sets (or inserts, if absent) `<meta name="robots" content="noindex">` — every `/s/**` response is noindex. */
function setRobotsNoindex(html: string): string {
  const tagRegex = /<meta[^>]*name="robots"[^>]*>/i;
  if (tagRegex.test(html)) {
    return html.replace(tagRegex, '<meta name="robots" content="noindex">');
  }
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, '  <meta name="robots" content="noindex">\n</head>');
  }
  return `<meta name="robots" content="noindex">${html}`;
}

/**
 * Hardcoded fallback for a shell-fetch failure — deliberately does NOT
 * reference the built SPA's hashed bundle filename (unknowable without the
 * very shell fetch that just failed). Still valid, noindex, safe HTML with
 * the same computed OG meta and a plain link back to the site, so a
 * Hosting-origin hiccup degrades to a simple page rather than a 500.
 */
function fallbackHtml(meta: ShareMeta, webBaseUrl: string): string {
  const title = escapeHtml(meta.title);
  const description = escapeHtml(meta.description);
  const canonicalUrl = escapeHtml(meta.canonicalUrl);
  // Active snapshot → the per-token generated card; null snapshot → the
  // generic static image (same non-leaking posture as applyMeta).
  const ogImageUrl = escapeHtml(meta.ogImageUrl ?? `${webBaseUrl}/og-image.png`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<meta name="robots" content="noindex">
<meta property="og:title" content="${title}">
<meta name="twitter:title" content="${title}">
<meta name="description" content="${description}">
<meta property="og:description" content="${description}">
<meta name="twitter:description" content="${description}">
<link rel="canonical" href="${canonicalUrl}">
<meta property="og:url" content="${canonicalUrl}">
<meta property="og:image" content="${ogImageUrl}">
<meta name="twitter:image" content="${ogImageUrl}">
</head>
<body>
<p>${title}</p>
<p><a href="${canonicalUrl}">Reload this page</a></p>
</body>
</html>`;
}
