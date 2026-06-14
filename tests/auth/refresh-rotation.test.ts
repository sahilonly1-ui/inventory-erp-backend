import { describe, it, expect, vi, beforeEach } from 'vitest';

// Illustrative unit test for the highest-risk path: refresh rotation + reuse
// detection. Prisma is mocked so the test stays fast and DB-free. In CI this
// pattern runs alongside integration tests against a throwaway Postgres.

const txState = {
  tokens: new Map<string, { id: string; userId: string; revokedAt: Date | null; expiresAt: Date }>(),
};

vi.mock('../../src/config/prisma', () => {
  const tx = {
    refreshToken: {
      findUnique: vi.fn(async ({ where }: any) => txState.tokens.get(where.tokenHash) ?? null),
      update: vi.fn(async ({ where, data }: any) => {
        for (const t of txState.tokens.values()) if (t.id === where.id) Object.assign(t, data);
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        for (const t of txState.tokens.values()) {
          if (t.userId === where.userId && t.revokedAt === null) Object.assign(t, data);
        }
      }),
      create: vi.fn(async ({ data }: any) => {
        txState.tokens.set(data.tokenHash, { id: 'new', userId: data.userId, revokedAt: null, expiresAt: data.expiresAt });
      }),
    },
    user: { findFirstOrThrow: vi.fn(async () => ({ id: 'u1', email: 'a@b.com' })) },
    auditLog: { create: vi.fn(async () => ({})) },
  };
  return { prisma: { $transaction: (fn: any) => fn(tx) } };
});

describe('refresh rotation', () => {
  beforeEach(() => txState.tokens.clear());

  it('rotates a valid token and revokes the old one', async () => {
    const { authService } = await import('../../src/modules/auth/auth.service');
    const { hashToken } = await import('../../src/utils/token.util');
    const raw = 'valid-token-aaaaaaaaaaaaaaaaaaaa';
    txState.tokens.set(hashToken(raw), {
      id: 't1', userId: 'u1', revokedAt: null, expiresAt: new Date(Date.now() + 1e6),
    });
    const result = await authService.refresh(raw);
    expect(result.accessToken).toBeTruthy();
    expect(result.refreshToken).not.toBe(raw);
    expect(txState.tokens.get(hashToken(raw))!.revokedAt).not.toBeNull();
  });

  it('detects reuse of a revoked token and kills the family', async () => {
    const { authService } = await import('../../src/modules/auth/auth.service');
    const { hashToken } = await import('../../src/utils/token.util');
    const raw = 'revoked-token-bbbbbbbbbbbbbbbbbbbb';
    txState.tokens.set(hashToken(raw), {
      id: 't2', userId: 'u1', revokedAt: new Date(), expiresAt: new Date(Date.now() + 1e6),
    });
    txState.tokens.set('other', { id: 't3', userId: 'u1', revokedAt: null, expiresAt: new Date(Date.now() + 1e6) });
    await expect(authService.refresh(raw)).rejects.toThrow(/reuse/i);
    expect(txState.tokens.get('other')!.revokedAt).not.toBeNull();
  });
});
