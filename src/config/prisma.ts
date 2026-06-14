import { PrismaClient } from '@prisma/client';
import { isProd } from './env';

// Single shared client. Hot-reload guard prevents connection leaks in dev.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({ log: isProd ? ['error', 'warn'] : ['query', 'error', 'warn'] });

if (!isProd) globalForPrisma.prisma = prisma;
