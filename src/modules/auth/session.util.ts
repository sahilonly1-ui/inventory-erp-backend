/**
 * Whether the login session behind a refresh token is still alive.
 *
 * Refresh tokens used to be single-use: each refresh revoked the token and
 * issued a new one. With the same browser open in two windows that cannot be
 * made safe — both windows hold the same stored token and can refresh at the
 * same instant (waking from sleep, opening both at start of day), so one of
 * them always presents a token the other has just retired, and treating that
 * as theft ended every window's session.
 *
 * Tokens are no longer rotated. This exists so that tokens retired by the old
 * scheme keep working: a retired token is accepted as long as the chain it was
 * rotated into still ends in a live token. A chain that ends in a revoked
 * token with nothing after it was ended on purpose (logout, or a user being
 * removed) and stays dead.
 */
export interface TokenRow {
  revokedAt: Date | null;
  expiresAt: Date;
  replacedByHash: string | null;
}

export async function sessionIsAlive(
  row: TokenRow,
  lookupByHash: (hash: string) => Promise<TokenRow | null>,
  now: Date = new Date(),
  maxHops = 20,
): Promise<boolean> {
  let current: TokenRow = row;
  const seen = new Set<string>();

  for (let hop = 0; hop <= maxHops; hop++) {
    if (!current.revokedAt) return current.expiresAt > now;   // reached a live token (or an expired one)
    if (!current.replacedByHash) return false;                 // ended deliberately

    if (seen.has(current.replacedByHash)) return false;        // loop — never legitimate
    seen.add(current.replacedByHash);

    const next = await lookupByHash(current.replacedByHash);
    if (!next) return false;                                   // successor gone
    current = next;
  }
  return false;                                                // implausibly long chain
}
