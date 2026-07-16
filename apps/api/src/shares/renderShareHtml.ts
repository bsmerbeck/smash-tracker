import escapeHtml from 'escape-html';
import { getFighterById, type PublicShareSnapshot } from '@smash-tracker/shared';
import { createTtlCache } from './ttlCache.js';

/** How long the fetched `spa.html` shell is cached in-memory before a re-fetch. */
const SHELL_CACHE_TTL_MS = 5 * 60 * 1000;
const SHELL_CACHE_KEY = 'spa-shell';

// Module-level: one Fastify process serves every request, so one shell cache
// (there is only ever one shell) suffices — see ttlCache.ts's module doc for
// why this is a plain in-memory Map, not an RTDB-backed cache.
const shellCache = createTtlCache<string>(SHELL_CACHE_TTL_MS);

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
}

/**
 * Phase 6 (Anonymous Share Experience & Discord Unfurls): renders the
 * always-200 `GET /s/:token` HTML response. Fetches (and in-memory caches)
 * the SPA's own pristine `spa.html` shell from the Hosting static origin —
 * NOT through `/s/:token` itself, which would recurse through the same
 * Hosting rewrite — then string-swaps ONLY the 7 head tags `useSeo.ts`
 * already manages client-side (og:title, twitter:title, description,
 * og:description, twitter:description, canonical, og:url), plus always sets
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
 * If the shell fetch throws or returns a non-2xx status, a hardcoded
 * minimal fallback template is returned instead, so a Hosting-origin hiccup
 * never turns into a 500 on the crawler/human path.
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
  } catch {
    return fallbackHtml(meta);
  }

  return applyMeta(shell, meta);
}

async function getShell(webBaseUrl: string, fetchImpl: typeof fetch): Promise<string> {
  const cached = shellCache.get(SHELL_CACHE_KEY);
  if (cached !== undefined) return cached;

  const response = await fetchImpl(`${webBaseUrl}/spa.html`);
  if (!response.ok) {
    throw new Error(`spa.html fetch failed: ${response.status}`);
  }
  const html = await response.text();
  shellCache.set(SHELL_CACHE_KEY, html);
  return html;
}

function computeMeta(
  snapshot: PublicShareSnapshot | null,
  token: string,
  webBaseUrl: string,
): ShareMeta {
  const canonicalUrl = `${webBaseUrl}/s/${token}`;

  if (!snapshot) {
    return { title: FALLBACK_TITLE, description: FALLBACK_DESCRIPTION, canonicalUrl };
  }

  const fighterAName = getFighterById(snapshot.fighterId)?.name ?? 'Unknown fighter';
  const fighterBName = getFighterById(snapshot.opponentFighterId)?.name ?? 'Unknown fighter';
  const stageLabel = snapshot.stage?.name;
  const matchDateLabel = new Date(snapshot.matchDate).toLocaleDateString('en-US');

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
  if (snapshot.redaction.showDisplayName && snapshot.ownerDisplayName) {
    description += ` Shared by ${snapshot.ownerDisplayName}.`;
  }

  return { title, description, canonicalUrl };
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

  return html.replace(tagRegex, (tag) => {
    if (/content="[^"]*"/i.test(tag)) {
      return tag.replace(/content="[^"]*"/i, `content="${escapedValue}"`);
    }
    return tag.replace(/\/?>$/, ` content="${escapedValue}"$&`);
  });
}

/** Replaces (or, if absent, inserts) `href="..."` on the `<link>` tag identified by `rel="relValue"`. */
function replaceLinkHref(html: string, relValue: string, hrefValue: string): string {
  const escapedValue = escapeHtml(hrefValue);
  const tagRegex = new RegExp(`<link[^>]*rel="${relValue}"[^>]*>`, 'i');
  if (!tagRegex.test(html)) return html;

  return html.replace(tagRegex, (tag) => {
    if (/href="[^"]*"/i.test(tag)) {
      return tag.replace(/href="[^"]*"/i, `href="${escapedValue}"`);
    }
    return tag.replace(/\/?>$/, ` href="${escapedValue}"$&`);
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
function fallbackHtml(meta: ShareMeta): string {
  const title = escapeHtml(meta.title);
  const description = escapeHtml(meta.description);
  const canonicalUrl = escapeHtml(meta.canonicalUrl);
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
</head>
<body>
<p>${title}</p>
<p><a href="${canonicalUrl}">Reload this page</a></p>
</body>
</html>`;
}
