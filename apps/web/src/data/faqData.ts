/**
 * V11 SEO: FAQ copy originally written for the signed-out landing page.
 *
 * V12 SEO: moved out of `pages/Home` and expanded from 4 to 10 entries so it
 * can be imported by BOTH the landing page (which now shows only the first
 * few, see `LandingContent.tsx`) and its own dedicated `/faq` page (which
 * renders the full list and owns the FAQPage JSON-LD — see
 * `pages/Faq/FaqPage.tsx`). Kept as one data structure so the rendered
 * question/answer pairs and whichever page's JSON-LD is generated from them
 * can never drift out of sync.
 */
export interface FaqEntry {
  question: string;
  answer: string;
}

export const faqEntries: FaqEntry[] = [
  {
    question: 'Is Smash Tracker free?',
    answer:
      'Yes — every core feature is free: GSP and Elite Smash tracking, start.gg/parry.gg sync, matchup analytics, stage mastery, Glicko-2 ratings, and scouting any player. AI-generated pre-bracket scouting reports are the one optional paid add-on, sold in small credit packs.',
  },
  {
    question: 'How does the GSP / Elite Smash tracker work?',
    answer:
      "Log a quickplay match with the GSP shown on the results screen and Smash Tracker plots your climb per character, using a community-reverse-engineered model of the hidden MMR behind GSP. There's no public Elite Smash API, so you set your character's Elite threshold yourself (the GSP page links to elitegsp.com's crowd-sourced estimates for reference), and Smash Tracker projects how many matches until you cross it.",
  },
  {
    question: 'Do I need a start.gg account?',
    answer:
      'No. You can sign in with email/password or Google and log matches manually. Linking a start.gg or parry.gg account is optional and adds tournament-set sync (characters, stages, seeds, and placements pulled in automatically) plus the ability to scout any other player on either site.',
  },
  {
    question: 'What is opponent scouting?',
    answer:
      "Search any start.gg or parry.gg player by profile URL, slug, or player id to see their characters, stages, and recent placements — useful for pre-bracket prep even if you've never played them before. Paid AI scouting reports turn that same data into a written game plan.",
  },
  {
    question: 'What is GSP in Smash Ultimate?',
    answer:
      "GSP stands for Global Smash Power — it's Nintendo's online quickplay ranking number, tracked separately for every character you play. It rises when you win and falls when you lose, and climbing high enough on a character's GSP puts you into Elite Smash matchmaking for that character.",
  },
  {
    question: 'How much GSP do you need for Elite Smash?',
    answer:
      "There's no fixed number — Nintendo never publishes one, and the real threshold rises over time as more of the population climbs. Our GSP Calculator estimates the current live Elite Smash threshold from a community-calibrated model, so you can see roughly how far your GSP is from Elite right now instead of relying on a stale number from a forum post.",
  },
  {
    question: 'How does start.gg/parry.gg sync work?',
    answer:
      'Link a start.gg or parry.gg account (from Settings → Integrations) and Smash Tracker pulls in your tournament sets automatically — characters, stages, seeds, and placements — instead of you typing every bracket match in by hand. Sync only reads public match data the same way each site’s own results pages do.',
  },
  {
    question: 'How are AI scouting reports priced?',
    answer:
      'AI scouting reports are priced at-cost: they run on the Claude API, and non-allowlisted accounts buy small credit packs to cover that usage — Smash Tracker doesn’t mark them up. Allowlisted accounts (and the app owner) generate reports for free.',
  },
  {
    question: 'What is Elite Smash?',
    answer:
      "Elite Smash is Smash Ultimate's top online quickplay bracket — once a character's GSP crosses that character's Elite threshold, quickplay matchmaking for that character moves you into the Elite pool of higher-ranked opponents.",
  },
  {
    question: 'Does Smash Tracker work for every character?',
    answer:
      'Yes — GSP, matchup, and stage tracking are all per-character, since GSP and Elite Smash thresholds themselves are tracked per-character in the game. Pick any primary or secondary fighter and Smash Tracker tracks it the same way.',
  },
];
