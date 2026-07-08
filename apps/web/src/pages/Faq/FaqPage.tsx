import { faqEntries } from '@/data/faqData';
import { PublicLayout } from '@/layouts/PublicLayout';
import { useSeo } from '@/hooks/useSeo';

/**
 * V12 SEO: FAQPage JSON-LD generated from the same `faqEntries` the visible
 * question/answer list below renders, so the structured data can never drift
 * out of sync with what's actually on the page. This page (not the landing
 * page) owns the FAQPage markup — see LandingContent.tsx's module doc for why
 * only one URL should emit it.
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
 * Public, crawlable FAQ page — the full `faqEntries` list (the landing page
 * shows only a preview). Its own URL and its own FAQPage structured data
 * mean this is the canonical place search engines should surface Smash
 * Tracker FAQ answers (e.g. "how much GSP for Elite Smash").
 */
export function FaqPage() {
  useSeo({
    title: 'Frequently Asked Questions | Smash Tracker',
    description:
      'Answers to common Smash Tracker questions: GSP and Elite Smash tracking, start.gg/parry.gg sync, pricing, and how the GSP calculator works.',
    canonicalPath: '/faq',
  });

  return (
    <PublicLayout>
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-12">
        <h1 className="text-center text-3xl font-bold tracking-tight">
          Frequently asked questions
        </h1>
        <div className="flex flex-col gap-6">
          {faqEntries.map((entry) => (
            <div key={entry.question}>
              <h2 className="font-medium">{entry.question}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{entry.answer}</p>
            </div>
          ))}
        </div>
        <script type="application/ld+json">{JSON.stringify(faqJsonLd())}</script>
      </div>
    </PublicLayout>
  );
}
