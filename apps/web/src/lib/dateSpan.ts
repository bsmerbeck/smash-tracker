/**
 * Plan 39.1-44 (sketch 003 `fmtSpan`): a span of two instants as month + year
 * — "Mar 2021 – Jun 2026". The two ends are formatted in the host-local zone
 * (the results list's rule) and the UI locale; a span inside one month (or a
 * single instant) collapses to that month alone. The separator is a parameter
 * so each host keeps its own punctuation (plan 45's ledger uses " → "). An
 * inverted pair is ordered oldest first.
 */
export function formatMonthSpan(
  fromMs: number,
  toMs: number,
  locale: string,
  separator: string,
): string {
  const formatter = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short' });
  const first = formatter.format(new Date(Math.min(fromMs, toMs)));
  const last = formatter.format(new Date(Math.max(fromMs, toMs)));
  return first === last ? first : `${first}${separator}${last}`;
}
