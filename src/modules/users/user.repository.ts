import { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma';

export const userRepository = {
  findById(id: string) {
    return prisma.user.findFirst({
      where: { id, isDeleted: false },
      include: { roles: true },
    });
  },

  list(params: { skip: number; take: number; search?: string }) {
    const where: Prisma.UserWhereInput = {
      isDeleted: false,
      ...(params.search
        ? {
            OR: [
              { email: { contains: params.search, mode: 'insensitive' } },
              { fullName: { contains: params.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    return prisma.$transaction([
      prisma.user.findMany({
        where,
        include: { roles: true },
        orderBy: { createdAt: 'desc' },
        skip: params.skip,
        take: params.take,
      }),
      prisma.user.count({ where }),
    ]);
  },
};
