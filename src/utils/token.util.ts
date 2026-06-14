import crypto from 'crypto';

// Opaque refresh / reset tokens. We store ONLY the SHA-256 hash in the DB,
// so a database leak does not expose usable tokens.
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function generateOpaqueToken(bytes = 48): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(bytes).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}
