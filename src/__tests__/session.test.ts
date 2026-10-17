/**
 * Run: npx ts-node --transpile-only src/__tests__/session.test.ts
 */
import { sessionIsAlive, TokenRow } from '../modules/auth/session.util';

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}`);
  if (!ok) console.log(`        expected ${expected}, got ${actual}`);
}

const now = new Date('2026-10-15T12:00:00Z');
const future = new Date('2027-01-01T00:00:00Z');
const past = new Date('2026-01-01T00:00:00Z');
const revoked = new Date('2026-10-14T00:00:00Z');

const store: Record<string, TokenRow> = {};
const lookup = async (h: string) => store[h] ?? null;
const reset = () => { for (const k of Object.keys(store)) delete store[k]; };

(async () => {
  console.log('\nRefresh-token session liveness:\n');

  check('a live, unrevoked token is alive',
    await sessionIsAlive({ revokedAt: null, expiresAt: future, replacedByHash: null }, lookup, now), true);

  check('an expired token is dead',
    await sessionIsAlive({ revokedAt: null, expiresAt: past, replacedByHash: null }, lookup, now), false);

  check('a token revoked with no successor (logout) is dead',
    await sessionIsAlive({ revokedAt: revoked, expiresAt: future, replacedByHash: null }, lookup, now), false);

  // The case that was logging people out: a token retired by rotation, whose
  // successor is live, presented by the second window.
  reset();
  store.B = { revokedAt: null, expiresAt: future, replacedByHash: null };
  check('a token retired by rotation is alive while its successor is live',
    await sessionIsAlive({ revokedAt: revoked, expiresAt: future, replacedByHash: 'B' }, lookup, now), true);

  reset();
  store.B = { revokedAt: revoked, expiresAt: future, replacedByHash: 'C' };
  store.C = { revokedAt: null, expiresAt: future, replacedByHash: null };
  check('a retired token several rotations back is alive',
    await sessionIsAlive({ revokedAt: revoked, expiresAt: future, replacedByHash: 'B' }, lookup, now), true);

  reset();
  store.B = { revokedAt: revoked, expiresAt: future, replacedByHash: null };
  check('a retired token whose chain was ended by logout is dead',
    await sessionIsAlive({ revokedAt: revoked, expiresAt: future, replacedByHash: 'B' }, lookup, now), false);

  reset();
  store.B = { revokedAt: null, expiresAt: past, replacedByHash: null };
  check('a retired token whose live end has expired is dead',
    await sessionIsAlive({ revokedAt: revoked, expiresAt: future, replacedByHash: 'B' }, lookup, now), false);

  reset();
  check('a retired token whose successor no longer exists is dead',
    await sessionIsAlive({ revokedAt: revoked, expiresAt: future, replacedByHash: 'MISSING' }, lookup, now), false);

  reset();
  store.B = { revokedAt: revoked, expiresAt: future, replacedByHash: 'A' };
  store.A = { revokedAt: revoked, expiresAt: future, replacedByHash: 'B' };
  check('a loop in the chain is dead, not an endless search',
    await sessionIsAlive({ revokedAt: revoked, expiresAt: future, replacedByHash: 'A' }, lookup, now), false);

  console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'}\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
