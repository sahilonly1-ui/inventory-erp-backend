import { prisma } from '../../config/prisma';
import { sessionIsAlive } from './session.util';
import { env } from '../../config/env';
import { BadRequestError, UnauthorizedError } from '../../common/errors';
import { writeAudit } from '../../common/audit.service';
import { hashPassword, verifyPassword, dummyVerify } from '../../utils/password.util';
import { signAccessToken } from '../../utils/jwt.util';
import { generateOpaqueToken, hashToken } from '../../utils/token.util';
import { authRepository } from './auth.repository';
import { LoginResult, RequestContext, TokenPair, AuthUserView } from './auth.dto';

const refreshExpiry = () => new Date(Date.now() + env.JWT_REFRESH_TTL_DAYS * 86_400_000);
const resetExpiry = () => new Date(Date.now() + env.PASSWORD_RESET_TTL_MIN * 60_000);

export const authService = {
  async login(email: string, password: string, ctx: RequestContext): Promise<LoginResult> {
    const user = await authRepository.findActiveUserByEmail(email);

    // Always run a verify to keep timing constant for unknown users.
    let valid = false;
    if (user && user.isActive) {
      valid = await verifyPassword(user.passwordHash, password);
    } else {
      await dummyVerify(password); // keep timing constant for unknown users
    }

    await authRepository.createLoginAudit({
      userId: user?.id ?? null,
      email,
      success: Boolean(valid),
      ipAddress: ctx.ip,
      userAgent: ctx.userAgent,
    });

    if (!user || !valid) throw new UnauthorizedError('Invalid credentials');

    const { token, tokenHash } = generateOpaqueToken();
    await prisma.$transaction(async (tx) => {
      await tx.refreshToken.create({
        data: { userId: user.id, tokenHash, expiresAt: refreshExpiry() },
      });
      await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    });

    return {
      user: { id: user.id, email: user.email, fullName: user.fullName },
      accessToken: signAccessToken({ sub: user.id, email: user.email }),
      refreshToken: token,
    };
  },

  // Refresh-token ROTATION with reuse detection.
  /**
   * Issue a fresh access token for a valid refresh token.
   *
   * The refresh token itself is NOT rotated. It used to be single-use, which
   * cannot work when one browser has the app open in several windows: they
   * share one stored token and can refresh at the same instant, so one always
   * presents a token the other just retired — and that was treated as theft,
   * ending every window's session. Logout, expiry, and removing or
   * deactivating the user remain the ways a session ends.
   *
   * The expiry slides forward with use, so a session in regular use does not
   * run into a fixed end date.
   */
  async refresh(rawToken: string): Promise<TokenPair> {
    const tokenHash = hashToken(rawToken);

    const existing = await prisma.refreshToken.findUnique({ where: { tokenHash } });
    if (!existing) throw new UnauthorizedError('Invalid refresh token');

    const alive = await sessionIsAlive(existing, async (h) =>
      prisma.refreshToken.findUnique({ where: { tokenHash: h } }),
    );
    if (!alive) throw new UnauthorizedError('Session has ended — please sign in again');

    const user = await prisma.user.findFirst({
      where: { id: existing.userId, isDeleted: false, isActive: true },
    });
    if (!user) throw new UnauthorizedError('Account is no longer active');

    // A token retired by the old rotating scheme is brought back into use, and
    // the expiry is pushed out once less than half of it remains (rather than
    // on every refresh, to avoid a write each time).
    const remaining = existing.expiresAt.getTime() - Date.now();
    const halfLife = (env.JWT_REFRESH_TTL_DAYS * 86_400_000) / 2;
    if (existing.revokedAt || remaining < halfLife) {
      await prisma.refreshToken.update({
        where: { id: existing.id },
        data: { revokedAt: null, replacedByHash: null, expiresAt: refreshExpiry() },
      });
    }

    return {
      accessToken: signAccessToken({ sub: user.id, email: user.email }),
      refreshToken: rawToken,
    };
  },

  async logout(rawToken: string): Promise<void> {
    await prisma.refreshToken.updateMany({
      where: { tokenHash: hashToken(rawToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  },

  // Returns the raw token ONLY for non-production delivery (dev/testing).
  // In production this is emailed; the API response stays generic.
  async forgotPassword(email: string): Promise<string | null> {
    const user = await authRepository.findActiveUserByEmail(email);
    if (!user || !user.isActive) return null;

    const { token, tokenHash } = generateOpaqueToken();
    await prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash, expiresAt: resetExpiry() },
    });
    return token;
  },

  async resetPassword(rawToken: string, newPassword: string): Promise<void> {
    const passwordHash = await hashPassword(newPassword); // hash outside tx (CPU heavy)
    const tokenHash = hashToken(rawToken);

    await prisma.$transaction(async (tx) => {
      const rec = await tx.passwordResetToken.findUnique({ where: { tokenHash } });
      if (!rec || rec.usedAt || rec.expiresAt < new Date()) {
        throw new BadRequestError('Invalid or expired reset token');
      }
      await tx.user.update({ where: { id: rec.userId }, data: { passwordHash } });
      await tx.passwordResetToken.update({ where: { id: rec.id }, data: { usedAt: new Date() } });
      await tx.refreshToken.updateMany({
        where: { userId: rec.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await writeAudit(tx, {
        userId: rec.userId,
        action: 'UPDATE',
        entityName: 'users',
        entityId: rec.userId,
        newValue: { event: 'PASSWORD_RESET' },
      });
    });
  },

  async changePassword(userId: string, current: string, next: string): Promise<void> {
    const user = await prisma.user.findFirstOrThrow({ where: { id: userId, isDeleted: false } });
    if (!(await verifyPassword(user.passwordHash, current))) {
      throw new BadRequestError('Current password is incorrect');
    }
    const passwordHash = await hashPassword(next);
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { passwordHash } });
      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await writeAudit(tx, {
        userId,
        action: 'UPDATE',
        entityName: 'users',
        entityId: userId,
        newValue: { event: 'PASSWORD_CHANGE' },
      });
    });
  },

  async me(userId: string): Promise<AuthUserView> {
    const user = await authRepository.findUserWithRoles(userId);
    if (!user) throw new UnauthorizedError();
    const permissions = new Set<string>();
    const roles: string[] = [];
    for (const role of user.roles) {
      roles.push(role.name);
      for (const p of role.permissions) permissions.add(p.code);
    }
    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      roles,
      permissions: [...permissions],
    };
  },
};
