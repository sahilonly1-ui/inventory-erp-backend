import { Prisma } from '@prisma/client';

/**
 * Per-unit sale/return history, kept in the imei_events table.
 *
 * Read and written with raw SQL on purpose: it is a small append-only log and
 * does not need a Prisma model (and the client regeneration that comes with
 * one) to be correct.
 */
type Db = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;

export type ImeiEventType = 'SOLD' | 'RETURNED';

export interface ImeiEventRow {
  id: string;
  imeiId: string;
  imei1: string;
  eventType: ImeiEventType;
  txnId: string | null;
  createdAt: Date;
}

export function recordImeiEvent(
  db: Db,
  e: { imeiId: string; imei1: string; productId: string; eventType: ImeiEventType; txnId: string | null; actorId: string | null },
) {
  return db.$executeRaw`
    INSERT INTO imei_events ("imeiId", imei1, "productId", "eventType", "txnId", "createdBy")
    VALUES (${e.imeiId}, ${e.imei1}, ${e.productId}, ${e.eventType}, ${e.txnId}, ${e.actorId})`;
}

/** Every event attached to any of the given transactions. */
export async function eventsForTxns(db: Db, txnIds: string[], eventType?: ImeiEventType): Promise<ImeiEventRow[]> {
  if (!txnIds.length) return [];
  if (eventType) {
    return db.$queryRaw<ImeiEventRow[]>`
      SELECT id, "imeiId", imei1, "eventType", "txnId", "createdAt"
      FROM imei_events WHERE "txnId" IN (${Prisma.join(txnIds)}) AND "eventType" = ${eventType}`;
  }
  return db.$queryRaw<ImeiEventRow[]>`
    SELECT id, "imeiId", imei1, "eventType", "txnId", "createdAt"
    FROM imei_events WHERE "txnId" IN (${Prisma.join(txnIds)})`;
}

/** Units from these receipts that have since been sold and returned. */
export async function unitsWithReturnHistory(db: Db, receiptTxnIds: string[]): Promise<string[]> {
  if (!receiptTxnIds.length) return [];
  const rows = await db.$queryRaw<{ imei1: string }[]>`
    SELECT DISTINCT u.imei1
    FROM imei_events e
    JOIN imei_inventory u ON u.id = e."imeiId"
    WHERE u."stockInTxnId" IN (${Prisma.join(receiptTxnIds)})`;
  return rows.map(r => r.imei1);
}

export function deleteImeiEvents(db: Db, ids: string[]) {
  if (!ids.length) return Promise.resolve(0);
  return db.$executeRaw`DELETE FROM imei_events WHERE id IN (${Prisma.join(ids)})`;
}

/** Most recent SOLD event for a unit — the sale a return undid. */
export async function latestSaleEvent(db: Db, imeiId: string): Promise<ImeiEventRow | null> {
  const rows = await db.$queryRaw<ImeiEventRow[]>`
    SELECT id, "imeiId", imei1, "eventType", "txnId", "createdAt"
    FROM imei_events WHERE "imeiId" = ${imeiId} AND "eventType" = 'SOLD'
    ORDER BY "createdAt" DESC LIMIT 1`;
  return rows[0] ?? null;
}
