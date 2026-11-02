import { AsyncLocalStorage } from 'async_hooks';
import { PrismaClient } from '@prisma/client';
import { isProd } from './env';

// Single shared client. Hot-reload guard prevents connection leaks in dev.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

const base: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({ log: isProd ? ['error', 'warn'] : ['query', 'error', 'warn'] });

if (!isProd) globalForPrisma.prisma = base;

/*
 * "All or nothing" across several service calls.
 *
 * Inside inOneTransaction(), every use of `prisma` — model queries, raw SQL and
 * nested prisma.$transaction(...) calls in the services — runs on ONE database
 * transaction. If anything throws, everything is rolled back. Outside it,
 * `prisma` behaves exactly as before.
 */
const txContext = new AsyncLocalStorage<any>();

export const prisma: PrismaClient = new Proxy(base, {
  get(target, prop, receiver) {
    const tx = txContext.getStore();
    if (tx) {
      if (prop === '$transaction') {
        // Nested transaction → join the outer one.
        return async (arg: any) => (typeof arg === 'function' ? arg(tx) : Promise.all(arg));
      }
      const v = (tx as any)[prop];
      if (v !== undefined) return typeof v === 'function' ? v.bind(tx) : v;
    }
    const v = Reflect.get(target, prop, receiver);
    return typeof v === 'function' ? v.bind(target) : v;
  },
}) as PrismaClient;

export const inTransaction = () => txContext.getStore() !== undefined;

export async function inOneTransaction<T>(fn: () => Promise<T>, opts: { timeout?: number; maxWait?: number } = {}): Promise<T> {
  if (txContext.getStore()) return fn();
  return base.$transaction(async (tx) => txContext.run(tx, fn), { timeout: opts.timeout ?? 180_000, maxWait: opts.maxWait ?? 20_000 });
}
