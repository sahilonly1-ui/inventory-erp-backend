/** Run: npx ts-node --transpile-only src/__tests__/imeiCodes.test.ts */
import { resolveScanned, normCode } from '../modules/imei/imei.codes';

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`);
}

const units = [
  { imei1: 'TT0256-EQ0001973', serialNo: null },
  { imei1: '350846581746502', serialNo: 'sn-Tab-9981' },
  { imei1: 'RQUS3218513', serialNo: null },
];

console.log('\nMatching scanned codes regardless of letter case:\n');

check('a serial saved in capitals is found when scanned in lower case',
  resolveScanned(['tt0256-eq0001973'], units), ['TT0256-EQ0001973']);

check('and when scanned in mixed case',
  resolveScanned(['Tt0256-Eq0001973'], units), ['TT0256-EQ0001973']);

check('exact case still works',
  resolveScanned(['RQUS3218513'], units), ['RQUS3218513']);

check('a tablet is found by its serial in any case, and resolves to its IMEI',
  resolveScanned(['SN-TAB-9981'], units), ['350846581746502']);

check('an IMEI scan is unaffected',
  resolveScanned(['350846581746502'], units), ['350846581746502']);

check('surrounding spaces are ignored',
  resolveScanned(['  rqus3218513 '], units), ['RQUS3218513']);

check('a code that matches nothing is returned as typed so it can be reported',
  resolveScanned(['zz9999'], units), ['zz9999']);

check('the same serial scanned in two cases counts once',
  resolveScanned(['rqus3218513', 'RQUS3218513'], units), ['RQUS3218513']);

check('several units resolve together, in order',
  resolveScanned(['rqus3218513', 'tt0256-eq0001973', 'nope'], units),
  ['RQUS3218513', 'TT0256-EQ0001973', 'nope']);

check('normCode trims and lowercases', normCode('  AbC-1 '), 'abc-1');

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'}\n`);
process.exit(failures === 0 ? 0 : 1);
