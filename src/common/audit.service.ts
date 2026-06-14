import { Prisma, PrismaClient, AuditAction } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

export interface AuditInput {
  userId?: string | null;
  action: AuditAction;
  entityName: string;
  entityId: string;
  oldValue?: unknown;
  newValue?: unknown;
  ipAddress?: string | null;
}

// Pass a transaction client so audit writes commit/rollback WITH the change.
export async function writeAudit(db: Db, input: AuditInput): Promise<void> {
  await db.auditLog.create({
    data: {
      userId: input.userId ?? null,
      action: input.action,
      entityName: input.entityName,
      entityId: input.entityId,
      oldValue: (input.oldValue ?? undefined) as Prisma.InputJsonValue | undefined,
      newValue: (input.newValue ?? undefined) as Prisma.InputJsonValue | undefined,
      ipAddress: input.ipAddress ?? null,
    },
  });
}
