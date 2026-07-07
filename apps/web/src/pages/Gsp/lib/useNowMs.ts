import { useState } from 'react';

/**
 * Mount-time "now" for the GSP page's computed-threshold/MMR conversions.
 *
 * `Date.now()` straight in render is impure (react-hooks/purity), so it's
 * captured once in a lazy `useState` initializer. Mount-time is plenty: the
 * computed Elite threshold drifts ~88 GSP/hour under the model, so it can't
 * visibly change within a page visit — and NOT ticking avoids re-render
 * churn for a number that moves by rounding error.
 */
export function useNowMs(): number {
  const [nowMs] = useState(() => Date.now());
  return nowMs;
}
