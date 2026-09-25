/**
 * Locale-aware percent formatting for a raw 0..1 rate (WR-C05,
 * 39.1-REVIEW.md). Several evidence lines used to build their own percent
 * text with a bare `${Math.round(rate * 100)}%` template literal BEFORE
 * handing it to `t()` as an interpolation value for a whole translated
 * sentence — that bakes in the English convention (no space before the `%`
 * sign) no matter what `i18n.language` actually is, so fr/de (whose
 * convention is `42 %`, a narrow no-break space before the sign) can never
 * get their own locale's spacing. `Intl.NumberFormat`'s `style: 'percent'`
 * already knows each locale's convention — this is the one shared call site
 * every percent-in-a-sentence value should route through instead of
 * reinventing the `Math.round(...) + '%'` string by hand.
 */
export function formatPercent(rate: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(rate);
}
