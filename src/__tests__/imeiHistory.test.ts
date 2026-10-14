/**
 * Run: npx ts-node --transpile-only src/__tests__/imeiHistory.test.ts
 *
 * Covers the carry-over of swipe/activation state across re-created units,
 * including the chain case where the newest deleted generation has already
 * lost the flags.
 */
import { mergeHistory, FlagRow } from '../modules/imei/imei.history';

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`);
}

const d = (s: string) => new Date(`${s}T12:00:00.000Z`);
const row = (over: Partial<FlagRow>): FlagRow => ({
  swiped: false, swipedAt: null, activated: false, activatedAt: null, updatedAt: d('2026-01-01'), ...over,
});

console.log('\nCarry-over of swipe / activation history:\n');

check('no earlier generations -> nothing carried',
  mergeHistory([]), { swiped: false, swipedAt: null, activated: false, activatedAt: null });

check('single deleted generation with flags is carried',
  mergeHistory([row({ swiped: true, swipedAt: d('2026-05-20'), activated: true, activatedAt: d('2026-05-26') })]),
  { swiped: true, swipedAt: d('2026-05-20'), activated: true, activatedAt: d('2026-05-26') });

// The case behind the reported loss: generation 1 had the history, an earlier
// edit produced generation 2 without it, and a later edit deleted generation 2.
// Reading only the newest deleted row would copy "nothing".
check('flags survive when the NEWEST deleted generation has already lost them',
  mergeHistory([
    row({ swiped: true, swipedAt: d('2026-05-20'), activated: true, activatedAt: d('2026-05-26'), updatedAt: d('2026-06-01') }),
    row({ updatedAt: d('2026-09-01') }),
  ]),
  { swiped: true, swipedAt: d('2026-05-20'), activated: true, activatedAt: d('2026-05-26') });

check('each flag comes from the most recent generation that had it',
  mergeHistory([
    row({ swiped: true, swipedAt: d('2026-03-01'), updatedAt: d('2026-03-02') }),
    row({ swiped: true, swipedAt: d('2026-04-01'), activated: true, activatedAt: d('2026-04-05'), updatedAt: d('2026-04-06') }),
    row({ updatedAt: d('2026-08-01') }),
  ]),
  { swiped: true, swipedAt: d('2026-04-01'), activated: true, activatedAt: d('2026-04-05') });

check('order of the input rows does not matter',
  mergeHistory([
    row({ updatedAt: d('2026-09-01') }),
    row({ activated: true, activatedAt: d('2026-05-26'), updatedAt: d('2026-06-01') }),
  ]),
  { swiped: false, swipedAt: null, activated: true, activatedAt: d('2026-05-26') });

check('swiped and activated are independent',
  mergeHistory([row({ swiped: true, swipedAt: d('2026-05-20') })]),
  { swiped: true, swipedAt: d('2026-05-20'), activated: false, activatedAt: null });

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'}\n`);
process.exit(failures === 0 ? 0 : 1);
