import { Link } from 'react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { faqEntries } from '@/data/faqData';
import { featureEntries } from './featureData';

/** V12 SEO: only a preview of the full FAQ set shows on the landing page — see module doc. */
const LANDING_FAQ_PREVIEW_COUNT = 5;

/**
 * Marketing copy shown below the sign-in card on the signed-out `/` landing
 * page. This is one of a handful of pages Google can index (everything past
 * sign-in is auth-gated), so it carries real, crawlable text describing what
 * the app actually does — feature names match src/layouts/nav.ts and each
 * feature's own page copy.
 *
 * V12 SEO: the FAQ section now shows only a preview (first
 * `LANDING_FAQ_PREVIEW_COUNT` entries) linking to the full `/faq` page, which
 * owns the complete list AND the FAQPage JSON-LD. Emitting FAQPage structured
 * data from both `/` and `/faq` would be duplicate structured data for the
 * same questions across two URLs, which search engines can penalize/ignore —
 * so this page intentionally emits none.
 */
export function LandingContent() {
  return (
    <div className="flex w-full max-w-5xl flex-col gap-12 px-4 pb-12">
      <section aria-labelledby="features-heading" className="flex flex-col gap-6">
        <h2 id="features-heading" className="text-center text-2xl font-semibold tracking-tight">
          Everything a competitive Smash Ultimate player needs, free
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {featureEntries.map((feature) => (
            <Card key={feature.title}>
              <CardHeader>
                <CardTitle>
                  <h3 className="text-base font-semibold">{feature.title}</h3>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">{feature.description}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section aria-labelledby="faq-heading" className="flex flex-col gap-6">
        <h2 id="faq-heading" className="text-center text-2xl font-semibold tracking-tight">
          Frequently asked questions
        </h2>
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
          {faqEntries.slice(0, LANDING_FAQ_PREVIEW_COUNT).map((entry) => (
            <div key={entry.question}>
              <h3 className="font-medium">{entry.question}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{entry.answer}</p>
            </div>
          ))}
        </div>
        <Link to="/faq" className="mx-auto text-sm font-medium text-primary hover:underline">
          See all FAQs →
        </Link>
      </section>

      <footer className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 border-t pt-6 text-sm text-muted-foreground">
        {/* V12 SEO: internal links so crawlers discover the public pages from `/`. */}
        <Link to="/gsp-calculator" className="hover:text-foreground hover:underline">
          Elite Smash GSP Calculator
        </Link>
        <span aria-hidden="true">·</span>
        <Link to="/faq" className="hover:text-foreground hover:underline">
          FAQ
        </Link>
        <span aria-hidden="true">·</span>
        <a
          href="https://github.com/bsmerbeck/smash-tracker/"
          target="_blank"
          rel="noreferrer"
          className="hover:text-foreground hover:underline"
        >
          View the source on GitHub
        </a>
        <span aria-hidden="true">·</span>
        <a
          href="https://discord.gg/9TN8RFZ"
          target="_blank"
          rel="noreferrer"
          className="hover:text-foreground hover:underline"
        >
          SSBU Training Grounds Discord
        </a>
      </footer>
    </div>
  );
}
