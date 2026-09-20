/**
 * Layout-oracle PURE core (Phase 39.1 Plan 09, UIX-01/UIX-03/UIX-06): the
 * measurement-to-violation logic, separated from the Puppeteer/Vite
 * orchestration in `guardLayout.mjs` so it is unit-testable without a
 * browser — the same "pure core plus a thin runner" split
 * `scl01BrowserBudget.mjs`/`scl01BrowserBudgetCore.mjs` already use.
 *
 * Every `evaluate*` function takes MEASUREMENTS (plain data the runner reads
 * out of a real page via Puppeteer) and returns a LIST of violations, never
 * a boolean and never only the first violation — UI-SPEC §13.1's oracle must
 * report every offender it finds, not stop at the first.
 */

/** UI-SPEC §13.1: a card taller than its content by more than this many px is a stretch violation. */
export const STRETCH_TOLERANCE_PX = 24;

/** UI-SPEC §6.3: total page height budget, in viewport heights, per viewport. */
export const SCROLL_BUDGET_2560X1440 = 3;
export const SCROLL_BUDGET_1440X900 = 5;

/** UI-SPEC §13.1's three named viewports, in the order the runner measures them. */
export const LAYOUT_ORACLE_VIEWPORTS = [
  { name: '2560x1440', width: 2560, height: 1440 },
  { name: '1440x900', width: 1440, height: 900 },
  { name: '390x844', width: 390, height: 844 },
];

/**
 * UI-SPEC §13.1's stretch condition:
 * `card.height − (lastChild.bottom − card.top + paddingBottom) > 24px`.
 * Each `card` is `{ selectorPath, height, lastChildBottom, top, paddingBottom }`.
 */
export function evaluateStretch(cards, tolerancePx = STRETCH_TOLERANCE_PX) {
  const violations = [];
  for (const card of cards) {
    const { selectorPath, height, lastChildBottom, top, paddingBottom } = card;
    const contentHeight = lastChildBottom - top + paddingBottom;
    const overflow = height - contentHeight;
    if (overflow > tolerancePx) {
      violations.push({
        type: 'stretch',
        selectorPath,
        height,
        contentHeight,
        overflow,
      });
    }
  }
  return violations;
}

/**
 * UI-SPEC §6.3's scroll budget: `scrollHeight / innerHeight` must not exceed
 * 3 at 2560×1440 or 5 at 1440×900. The 390×844 viewport carries no scroll
 * budget (only the horizontal-overflow check applies there) — a viewport
 * name with no entry in `budgets` is silently exempt.
 */
export function evaluateScrollBudget(
  { scrollHeight, innerHeight, viewportName },
  budgets = { '2560x1440': SCROLL_BUDGET_2560X1440, '1440x900': SCROLL_BUDGET_1440X900 },
) {
  const budget = budgets[viewportName];
  if (budget === undefined) {
    return [];
  }
  const ratio = scrollHeight / innerHeight;
  if (ratio > budget) {
    return [{ type: 'scroll-budget', viewportName, ratio, budget }];
  }
  return [];
}

/** UI-SPEC §6.3: no horizontal page scroll at any viewport (390px is where it actually bites). */
export function evaluateHorizontalOverflow({ scrollWidth, innerWidth }) {
  if (scrollWidth > innerWidth) {
    return [{ type: 'horizontal-overflow', scrollWidth, innerWidth }];
  }
  return [];
}

/**
 * UI-SPEC §6.5 rule 6: an element carrying the truncation-guard attribute
 * (`data-truncate-guard`) must have `scrollWidth ≤ clientWidth` OR a `title`
 * attribute with the full string. Each `element` is
 * `{ selectorPath, scrollWidth, clientWidth, hasTitle }`.
 */
export function evaluateTruncation(elements) {
  const violations = [];
  for (const element of elements) {
    const { selectorPath, scrollWidth, clientWidth, hasTitle } = element;
    if (scrollWidth > clientWidth && !hasTitle) {
      violations.push({ type: 'truncation', selectorPath, scrollWidth, clientWidth });
    }
  }
  return violations;
}
