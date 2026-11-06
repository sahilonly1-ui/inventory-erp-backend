/**
 * How long to leave a store alone after a check found the product is not sold there.
 *
 * A store used to be skipped for a flat three days after ONE "not listed" result.
 * That result can be wrong — a search that did not load properly looks the same
 * as a product that is not there — and then the store went unchecked for days
 * and the product simply showed no price. So a first result is rechecked on the
 * next cycle, a second after a day, and only a store that has said "not listed"
 * three checks running is left alone for the full three days.
 */
export function notListedRetryHours(consecutive: number): number {
  if (consecutive >= 3) return 72;
  if (consecutive === 2) return 24;
  return 6;
}

/** How many of the most recent results (newest first) are an unbroken run of 'not_listed'. */
export function leadingNotListed(recentNewestFirst: string[]): number {
  let n = 0;
  for (const s of recentNewestFirst) { if (s === 'not_listed') n++; else break; }
  return n;
}
