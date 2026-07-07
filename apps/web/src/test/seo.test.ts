import { describe, expect, it } from 'vitest';

/**
 * V11 SEO: robots.txt and sitemap.xml must be real static files under
 * apps/web/public/ so Firebase Hosting serves them directly (Hosting serves
 * public/ files before falling back to the SPA rewrite that would otherwise
 * return index.html for these paths). Vite copies public/ verbatim into
 * dist/ on build, so asserting the source files' content here is equivalent
 * to asserting the build output is correct.
 *
 * `apps/web`'s tsconfig has no Node types (it's a browser-only app), so this
 * reads the files via Vite's `?raw` import + `import.meta.glob` instead of
 * `node:fs` — both are covered by the `vite/client` ambient types already in
 * scope for every other test in this app.
 */
const publicTextFiles = import.meta.glob('/public/{robots.txt,sitemap.xml}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const publicBinaryFiles = import.meta.glob('/public/og-image.png', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>;

function readPublicFile(path: string): string {
  const contents = publicTextFiles[path];
  if (contents === undefined) {
    throw new Error(`Expected ${path} to exist under apps/web/public/`);
  }
  return contents;
}

describe('SEO static files (apps/web/public/)', () => {
  it('robots.txt allows all crawlers and points at the sitemap', () => {
    const contents = readPublicFile('/public/robots.txt');
    expect(contents).toMatch(/User-agent:\s*\*/);
    expect(contents).toMatch(/Allow:\s*\//);
    expect(contents).toContain('Sitemap: https://smash-tracker-f97b7.web.app/sitemap.xml');
  });

  it('sitemap.xml lists only the crawlable root route', () => {
    const contents = readPublicFile('/public/sitemap.xml');
    expect(contents).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(contents).toContain('<loc>https://smash-tracker-f97b7.web.app/</loc>');
    // Every other route requires auth and can't be indexed, so exactly one
    // <url> entry is expected.
    expect(contents.match(/<url>/g)).toHaveLength(1);
  });

  it('og-image.png exists for OpenGraph/Twitter card previews', () => {
    expect(Object.keys(publicBinaryFiles)).toContain('/public/og-image.png');
  });
});
