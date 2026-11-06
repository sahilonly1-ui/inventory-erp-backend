/** Run: npx ts-node --transpile-only src/__tests__/notListed.test.ts */
import { notListedRetryHours, leadingNotListed } from '../modules/pricewatch/notListed';

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
console.log('\nHow long a "not listed" store is left alone:\n');
check('seen once: look again on the next cycle, not in three days', notListedRetryHours(1), 6);
check('seen twice running: a day', notListedRetryHours(2), 24);
check('three times running: now the full three days', notListedRetryHours(3), 72);
check('more than three stays at three days', notListedRetryHours(9), 72);
check('streak counts only the unbroken run at the front',
  leadingNotListed(['not_listed', 'not_listed', 'ok', 'not_listed']), 2);
check('a price in between resets it', leadingNotListed(['ok', 'not_listed', 'not_listed']), 0);
check('a blocked or failed check breaks the run too', leadingNotListed(['not_listed', 'blocked', 'not_listed']), 1);
check('no history is a streak of zero', leadingNotListed([]), 0);
console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'}\n`);
process.exit(failures === 0 ? 0 : 1);
