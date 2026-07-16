import escapeHtml from 'escape-html';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { getFighterById, type PublicShareSnapshot } from '@smash-tracker/shared';
import { createTtlCache } from './ttlCache.js';
import { interRegularFont } from './fonts/interRegular.js';

const IMAGE_WIDTH = 1200;
const IMAGE_HEIGHT = 630;

/** Matches the `og.png` route's own `Cache-Control: public, max-age=300` — no point caching the render longer than clients/crawlers are told to. */
const PNG_CACHE_TTL_MS = 5 * 60 * 1000;
/** Sprites are static, content-addressed-by-fighter-id assets — safe to cache far longer than the PNG itself. */
const SPRITE_CACHE_TTL_MS = 60 * 60 * 1000;

// Module-level, per-Cloud-Run-instance (ttlCache.ts's module doc explains
// why this is a plain Map, not RTDB-backed). Keyed by token for the PNG
// cache (bounds re-render cost on a viral share); keyed by fighter id for
// the sprite cache (two sprites, reused across every share featuring that
// character).
const pngCache = createTtlCache<Buffer>(PNG_CACHE_TTL_MS);
const spriteCache = createTtlCache<string>(SPRITE_CACHE_TTL_MS);

/**
 * Test-only seam: clears the module-level PNG + sprite caches. Without it,
 * the first successful test in a file caches sprite data-URIs (1h TTL) and
 * every later sprite-fetch-FAILURE test silently renders the cached sprites
 * instead of the sprite-less degrade branch it claims to cover. Never
 * called by production code.
 */
export function resetOgImageCachesForTests(): void {
  pngCache.clear();
  spriteCache.clear();
}

/** Satori's plain-object element form (no JSX transform in apps/api — RESEARCH.md Pattern 5). Cast at the `satori()` call site since satori's own type expects React's `ReactNode` (a devDependency this package never installs). */
type SatoriElement = {
  type: string;
  props: {
    style?: Record<string, string | number>;
    children?: SatoriElement | SatoriElement[] | string;
    [key: string]: unknown;
  };
};

export interface RenderOgImageOptions {
  /** Cache key — the share token (the PNG is derived from the token's snapshot, but caching by token is simplest and matches the og.png route's cache lifetime). */
  token: string;
  /** The public, redacted snapshot (from `RtdbService.getShareByToken`). Callers must not invoke this for a null/unknown/revoked lookup — the route serves the static fallback directly in that case (T-06-04). */
  snapshot: PublicShareSnapshot;
  /** SPA/Hosting origin sprites are fetched from (`env.WEB_BASE_URL`). */
  webBaseUrl: string;
  /** Overridable fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Phase 6 (Anonymous Share Experience & Discord Unfurls): renders the
 * 1200x630 `GET /s/:token/og.png` card via satori (SVG) + `@resvg/resvg-js`
 * (PNG rasterization). Content is derived ONLY from the public, redacted
 * snapshot — both fighter sprites, W/L result, stage, match date, reviewed-
 * moments count, grandfinals.gg branding, and the owner display name ONLY
 * when `redaction.showDisplayName` is true (OG-02/OG-03, T-06-02). The
 * display name is passed through `escape-html` before it becomes a satori
 * text node (T-06-03) — defense-in-depth even though satori rasterizes text
 * to vector paths rather than parsing HTML, matching the plan's explicit
 * requirement and this codebase's first cross-user-text-to-anonymous-party
 * surface.
 *
 * Sprites are fetched server-side from the Hosting origin
 * (`${webBaseUrl}${getFighterById(id).url}`), base64-encoded into a
 * `data:image/png;base64,...` URI (RESEARCH.md Pattern 5/A2 — sidesteps any
 * ambiguity about satori's own remote-URL fetch support), and cached
 * per-fighter-id so a viral share doesn't refetch the same two sprites on
 * every request. The rendered PNG itself is cached per-token, matching the
 * route's own `Cache-Control: public, max-age=300`.
 *
 * NEVER throws: on any failure (sprite fetch, satori render, resvg
 * rasterization), returns `null` — the caller (shareOgImage.ts route) is
 * responsible for serving the static `apps/web/public/og-image.png`
 * fallback so an image-pipeline failure never 500s the crawler path.
 */
export async function renderOgImage({
  token,
  snapshot,
  webBaseUrl,
  fetchImpl = fetch,
}: RenderOgImageOptions): Promise<Buffer | null> {
  const cached = pngCache.get(token);
  if (cached !== undefined) return cached;

  try {
    const png = await render(snapshot, webBaseUrl, fetchImpl);
    pngCache.set(token, png);
    return png;
  } catch (err) {
    // Log-and-degrade, never throw (the caller serves the static fallback) —
    // but a silent degrade would make a persistent satori/resvg failure
    // invisible in Cloud Run logs. console.error because this module-level
    // helper has no request-scoped Fastify logger.
    console.error('og-image render failed, caller will serve the static fallback', err);
    return null;
  }
}

async function render(
  snapshot: PublicShareSnapshot,
  webBaseUrl: string,
  fetchImpl: typeof fetch,
): Promise<Buffer> {
  const [spriteA, spriteB] = await Promise.all([
    fetchSpriteDataUri(snapshot.fighterId, webBaseUrl, fetchImpl),
    fetchSpriteDataUri(snapshot.opponentFighterId, webBaseUrl, fetchImpl),
  ]);

  const fighterAName = getFighterById(snapshot.fighterId)?.name ?? 'Unknown fighter';
  const fighterBName = getFighterById(snapshot.opponentFighterId)?.name ?? 'Unknown fighter';
  const stageLabel = snapshot.stage?.name ?? null;
  const matchDateLabel = new Date(snapshot.matchDate).toLocaleDateString('en-US');
  const resultLabel = snapshot.result === 'win' ? 'W' : 'L';
  const ownerDisplayName =
    snapshot.redaction.showDisplayName && snapshot.ownerDisplayName
      ? escapeHtml(snapshot.ownerDisplayName)
      : null;

  const tree = buildTree({
    spriteA,
    spriteB,
    fighterAName,
    fighterBName,
    resultLabel,
    stageLabel,
    matchDateLabel,
    reviewedMomentsCount: snapshot.reviewedMomentsCount,
    ownerDisplayName,
  });

  const svg = await satori(tree as unknown as Parameters<typeof satori>[0], {
    width: IMAGE_WIDTH,
    height: IMAGE_HEIGHT,
    fonts: [{ name: 'Inter', data: interRegularFont, weight: 400, style: 'normal' }],
  });

  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: IMAGE_WIDTH } });
  return resvg.render().asPng();
}

interface TreeInput {
  spriteA: string | null;
  spriteB: string | null;
  fighterAName: string;
  fighterBName: string;
  resultLabel: string;
  stageLabel: string | null;
  matchDateLabel: string;
  reviewedMomentsCount: number;
  ownerDisplayName: string | null;
}

function buildTree(input: TreeInput): SatoriElement {
  const sprite = (src: string | null, name: string): SatoriElement =>
    src
      ? { type: 'img', props: { src, width: 160, height: 160, style: { objectFit: 'contain' } } }
      : {
          type: 'div',
          props: {
            style: {
              width: 160,
              height: 160,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#a1a1aa',
              fontSize: 20,
            },
            children: name,
          },
        };

  const metaLine = [
    `${input.reviewedMomentsCount} timestamped moments`,
    input.stageLabel,
    input.matchDateLabel,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ');

  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        background: '#18181b',
        color: '#fafafa',
        fontFamily: 'Inter',
        padding: 64,
      },
      children: [
        {
          type: 'div',
          props: {
            style: { display: 'flex', alignItems: 'center', gap: 32, flex: 1 },
            children: [
              sprite(input.spriteA, input.fighterAName),
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    flex: 1,
                    gap: 8,
                  },
                  children: [
                    {
                      type: 'div',
                      props: {
                        style: { display: 'flex', fontSize: 48, fontWeight: 700 },
                        children: `${input.fighterAName} vs ${input.fighterBName}`,
                      },
                    },
                    {
                      type: 'div',
                      props: {
                        style: { display: 'flex', fontSize: 32, color: '#a1a1aa' },
                        children: `Result: ${input.resultLabel} · ${metaLine}`,
                      },
                    },
                    ...(input.ownerDisplayName
                      ? [
                          {
                            type: 'div',
                            props: {
                              style: { display: 'flex', fontSize: 24, color: '#a1a1aa' },
                              children: `Shared by ${input.ownerDisplayName}`,
                            },
                          } satisfies SatoriElement,
                        ]
                      : []),
                  ],
                },
              },
              sprite(input.spriteB, input.fighterBName),
            ],
          },
        },
        {
          type: 'div',
          props: {
            style: { display: 'flex', fontSize: 28, color: '#71717a' },
            children: 'grandfinals.gg',
          },
        },
      ],
    },
  };
}

async function fetchSpriteDataUri(
  fighterId: number,
  webBaseUrl: string,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  const cacheKey = `sprite:${fighterId}`;
  const cached = spriteCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const fighter = getFighterById(fighterId);
  if (!fighter) return null;

  try {
    const response = await fetchImpl(`${webBaseUrl}${fighter.url}`);
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    const dataUri = `data:image/png;base64,${buffer.toString('base64')}`;
    spriteCache.set(cacheKey, dataUri);
    return dataUri;
  } catch (err) {
    // Log-and-degrade (the card renders sprite-less), never throw.
    console.error(`og-image sprite fetch failed for fighter ${fighterId}, degrading card`, err);
    return null;
  }
}
