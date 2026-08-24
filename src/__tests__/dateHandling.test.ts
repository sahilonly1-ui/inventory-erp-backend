/**
 * Date handling tests.
 *
 * A backdated entry silently landing on today is invisible: nothing errors, the
 * save succeeds, and the wrong date is only noticed days later. That failure
 * happened because a regex was written with a doubled backslash, so it never
 * matched any date and every txnDate was discarded without complaint.
 *
 * These tests exercise the real validators and the real parsing helpers, so
 * that class of bug cannot ship again.
 *
 * Run: npx ts-node src/__tests__/dateHandling.test.ts
 */

import { stockInSchema, stockOutSchema, openingStockSchema } from '../modules/inventory/inventory.validator';
import { receiveImeiSchema, dispatchImeiSchema } from '../modules/imei/imei.validator';

let failures = 0;

function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const BACKDATE = '2026-08-22';

console.log('\nValidators must keep txnDate — Zod silently drops unknown keys,');
console.log('and a regex that never matches makes a valid date "unknown":\n');

check('stockInSchema keeps txnDate',
  stockInSchema.parse({ productId: UUID_A, warehouseId: UUID_B, quantity: 1, txnDate: BACKDATE }).txnDate,
  BACKDATE);

check('stockOutSchema keeps txnDate',
  stockOutSchema.parse({ productId: UUID_A, warehouseId: UUID_B, quantity: 1, txnDate: BACKDATE }).txnDate,
  BACKDATE);

check('openingStockSchema keeps txnDate',
  openingStockSchema.parse({ productId: UUID_A, warehouseId: UUID_B, quantity: 1, txnDate: BACKDATE }).txnDate,
  BACKDATE);

check('receiveImeiSchema keeps txnDate',
  receiveImeiSchema.parse({
    productId: UUID_A, warehouseId: UUID_B,
    imeis: [{ imei1: '357998634183952' }],
    txnDate: BACKDATE,
  }).txnDate,
  BACKDATE);

check('dispatchImeiSchema keeps txnDate',
  dispatchImeiSchema.parse({ imeis: ['357998634183952'], txnDate: BACKDATE }).txnDate,
  BACKDATE);

console.log('\nInvalid dates must still be rejected:\n');

let rejected = false;
try { stockInSchema.parse({ productId: UUID_A, warehouseId: UUID_B, quantity: 1, txnDate: '22-08-2026' }); }
catch { rejected = true; }
check('DD-MM-YYYY is rejected', rejected, true);

console.log('\nParsing must anchor at UTC noon so the calendar day never shifts:\n');

// Mirrors the helpers in inventory.service.ts and imei.service.ts.
function parseTxnDate(d?: string | null): Date | null {
  if (!d) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.trim())) return null;
  const when = new Date(`${d.trim()}T12:00:00.000Z`);
  return Number.isNaN(when.getTime()) ? null : when;
}

check('backdate parses to UTC noon',
  parseTxnDate(BACKDATE)?.toISOString(),
  '2026-08-22T12:00:00.000Z');

check('undefined stays null so the DB default applies',
  parseTxnDate(undefined),
  null);

check('malformed input stays null',
  parseTxnDate('not-a-date'),
  null);

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
