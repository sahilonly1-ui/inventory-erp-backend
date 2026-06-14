import { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma';

export const authRepository = {
  findActiveUserByEmail(email: string) {
    return prisma.user.findFirst({ where: { email, isDeleted: false } });
  },

  findUserWithRoles(id: string) {
    return prisma.user.findFirst({
      where: { id, isDeleted: false },
      include: { roles: { include: { permissions: true } } },
    });
  },

  createLoginAudit(data: {
    userId: string | null;
    email: string;
    success: boolean;
    ipAddress: string | null;
    userAgent: string | null;
  }) {
    return prisma.loginAudit.create({ data });
  },

  findRefreshByHash(tokenHash: string, tx?: Prisma.TransactionClient) {
    return (tx ?? prisma).refreshToken.findUnique({ where: { tokenHash } });
  },

  findResetByHash(tokenHash: string, tx?: Prisma.TransactionClient) {
    return (tx ?? prisma).passwordResetToken.findUnique({ where: { tokenHash } });
  },
};
