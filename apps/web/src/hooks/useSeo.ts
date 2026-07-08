import { useEffect } from 'react';

const SITE_ORIGIN = 'https://grandfinals.gg';

export interface UseSeoOptions {
  /** Sets `document.title` and (when provided) `og:title`/`twitter:title`. */
  title: string;
  /** Mutates `meta[name=description]`, `og:description`, `twitter:description`. Omit to leave the static index.html copy in place. */
  description?: string;
  /** Path (e.g. `/faq`) used to build `link[rel=canonical]` and `og:url`. Omit to leave the static index.html canonical in place. */
  canonicalPath?: string;
  /** When true, adds `meta[name=robots] content=noindex`; when false/omitted, removes that tag if present. */
  noindex?: boolean;
}

/**
 * V12 SEO: per-route document head management, without react-helmet.
 *
 * `index.html` ships static title/description/canonical/OG/twitter tags for
 * the `/` landing route (so it's correct even before JS runs and for the
 * prerendered snapshot of `/`). Every other public route needs its OWN
 * title/description/canonical — this hook mutates those SAME static tags in
 * place on mount rather than creating parallel ones, so there is never more
 * than one of each tag in the document (duplicate meta/canonical tags are a
 * known SEO footgun that confuses which one crawlers honor).
 *
 * Plain DOM mutation in a `useEffect` is enough here: prerendering
 * (scripts/prerender.mjs) waits for each route's content to mount before
 * snapshotting `outerHTML`, so by the time the crawler-facing HTML is
 * captured, this effect has already run and the static tags reflect the
 * current route.
 */
export function useSeo({ title, description, canonicalPath, noindex }: UseSeoOptions): void {
  useEffect(() => {
    document.title = title;
    setMetaContent('meta[property="og:title"]', title);
    setMetaContent('meta[name="twitter:title"]', title);

    if (description !== undefined) {
      setMetaContent('meta[name="description"]', description);
      setMetaContent('meta[property="og:description"]', description);
      setMetaContent('meta[name="twitter:description"]', description);
    }

    if (canonicalPath !== undefined) {
      const url = `${SITE_ORIGIN}${canonicalPath}`;
      setLinkHref('link[rel="canonical"]', url);
      setMetaContent('meta[property="og:url"]', url);
    }

    setRobotsNoindex(noindex ?? false);
  }, [title, description, canonicalPath, noindex]);
}

/** Updates an existing `<meta>` tag's `content`, or creates one appended to `<head>` if it doesn't exist yet. */
function setMetaContent(selector: string, content: string): void {
  let el = document.head.querySelector<HTMLMetaElement>(selector);
  if (!el) {
    el = document.createElement('meta');
    const match = /\[(name|property)="([^"]+)"\]/.exec(selector);
    if (match) {
      el.setAttribute(match[1]!, match[2]!);
    }
    document.head.appendChild(el);
  }
  el.setAttribute('content', content);
}

/** Updates an existing `<link>` tag's `href`, or creates one appended to `<head>` if it doesn't exist yet. */
function setLinkHref(selector: string, href: string): void {
  let el = document.head.querySelector<HTMLLinkElement>(selector);
  if (!el) {
    el = document.createElement('link');
    const match = /\[(rel)="([^"]+)"\]/.exec(selector);
    if (match) {
      el.setAttribute(match[1]!, match[2]!);
    }
    document.head.appendChild(el);
  }
  el.setAttribute('href', href);
}

/** Adds or removes `meta[name=robots]` — removed (not left as `content="index"`) when not noindex, so the tag's mere presence never has to be interpreted. */
function setRobotsNoindex(noindex: boolean): void {
  const existing = document.head.querySelector<HTMLMetaElement>('meta[name="robots"]');
  if (!noindex) {
    existing?.remove();
    return;
  }
  if (existing) {
    existing.setAttribute('content', 'noindex');
    return;
  }
  const el = document.createElement('meta');
  el.setAttribute('name', 'robots');
  el.setAttribute('content', 'noindex');
  document.head.appendChild(el);
}
