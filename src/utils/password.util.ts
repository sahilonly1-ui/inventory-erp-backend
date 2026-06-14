import argon2 from 'argon2';

const OPTS: argon2.Options = { type: argon2.argon2id };

export const hashPassword = (plain: string): Promise<string> => argon2.hash(plain, OPTS);

export const verifyPassword = (hash: string, plain: string): Promise<boolean> =>
  argon2.verify(hash, plain).catch(() => false);

// Anti-enumeration: when the email is unknown we still perform a real Argon2
// verify against a cached dummy hash so login timing stays constant.
let dummyHashCache: string | null = null;
export async function dummyVerify(plain: string): Promise<void> {
  if (!dummyHashCache) dummyHashCache = await argon2.hash('invalid-placeholder-password', OPTS);
  await verifyPassword(dummyHashCache, plain);
}
