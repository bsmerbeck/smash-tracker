import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { featureEntries } from './featureData';
import { faqEntries } from './faqData';

/**
 * V11 SEO: FAQPage JSON-LD generated from the same `faqEntries` the visible
 * <FaqSection> below renders, so the structured data can never drift out of
 * sync with what's actually on the page.
 */
function faqJsonLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqEntries.map((entry) => ({
      '@type': 'Question',
      name: entry.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: entry.answer,
      },
    })),
  };
}

/**
 * Marketing copy shown below the sign-in card on the signed-out `/` landing
 * page. This is the only page Google can index (everything else is
 * auth-gated), so it carries real, crawlable text describing what the app
 * actually does — feature names match src/layouts/nav.ts and each feature's
 * own page copy.
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
          {faqEntries.map((entry) => (
            <div key={entry.question}>
              <h3 className="font-medium">{entry.question}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{entry.answer}</p>
            </div>
          ))}
        </div>
        <script type="application/ld+json">{JSON.stringify(faqJsonLd())}</script>
      </section>

      <footer className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 border-t pt-6 text-sm text-muted-foreground">
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
