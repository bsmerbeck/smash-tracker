/**
 * V11 SEO: FAQ copy for the signed-out landing page. Kept as one data
 * structure so the rendered <FaqSection> and the FAQPage JSON-LD emitted
 * alongside it can never drift out of sync — see LandingContent.tsx.
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
];
