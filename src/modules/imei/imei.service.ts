import { ImeiStatus, Prisma, TransactionType } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { BadRequestError, NotFoundError } from '../../common/errors';
import { writeAudit } from '../../common/audit.service';
import { emitStockChanged } from '../../common/events';
import { applyLedgerMovementTx } from '../inventory/inventory.service';
import { assertConsistentTx } from '../inventory/reconciliation.service';
import { inventoryRepository } from '../inventory/inventory.repository';
import { imeiRepository, LockedImei } from './imei.repository';
import { Actor } from '../inventory/inventory.dto';
import { ReceiveImeiInput, DispatchImeiInput } from './imei.dto';
import { recordImeiEvent } from './imei.events';

// Availability is defined as IMEI status === IN_STOCK. A status change shifts
// StockLevel by the change in IN_STOCK membership, keeping all three counts equal.
export const isInStock = (s: ImeiStatus): boolean => s === ImeiStatus.IN_STOCK;
export function statusStockDelta(from: ImeiStatus, to: ImeiStatus): number {
  return (isInStock(to) ? 1 : 0) - (isInStock(from) ? 1 : 0);
}

/** "YYYY-MM-DD" from the dispatch screen → UTC noon, matching the ledger. */
function parseDispatchDate(d?: string | null): Date | null {
  if (!d) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.trim())) return null;
  const when = new Date(`${d.trim()}T12:00:00.000Z`);
  return Number.isNaN(when.getTime()) ? null : when;
}

/**
 * Map whatever was scanned to the unit's IMEI. A tablet is stored under its
 * IMEI but also carries a serial number, and either may be what gets scanned
 * at the counter — a serial scan has to find the same unit, not report it
 * missing. Codes that match nothing are returned unchanged so the caller can
 * still report them as not found.
 */
async function resolveCodes(tx: Prisma.TransactionClient, codes: string[]): Promise<string[]> {
  if (!codes.length) return codes;
  const rows = await tx.imeiInventory.findMany({
    where: { isDeleted: false, OR: [{ imei1: { in: codes } }, { serialNo: { in: codes } }] },
    select: { imei1: true, serialNo: true },
  });
  const known = new Set(rows.map(r => r.imei1));
  const bySerial = new Map<string, string>();
  for (const r of rows) if (r.serialNo) bySerial.set(r.serialNo, r.imei1);
  return [...new Set(codes.map(c => (known.has(c) ? c : (bySerial.get(c) ?? c))))];
}

export const imeiService = {
  // Stock-in for IMEI products: create units + ledger inbound, same transaction.
  async receive(input: ReceiveImeiInput, actor: Actor) {
    const product = await inventoryRepository.findActiveProduct(input.productId);
    if (!product) throw new NotFoundError('Product not found');
    if (!product.imeiRequired && !(input as any).force) {
      throw new BadRequestError('Product is not IMEI-tracked; use /inventory/stock-in');
    }

    // Guard against duplicates BEFORE attempting the insert. Without this the
    // DB throws a bare unique-constraint error that names no IMEI, leaving the
    // user with no idea which scan to fix.
    const incoming = input.imeis.map(i => i.imei1);
    const dupesInPayload = incoming.filter((v, idx) => incoming.indexOf(v) !== idx);
    if (dupesInPayload.length) {
      const list = [...new Set(dupesInPayload)];
      throw new BadRequestError(
        `Duplicate IMEI in this batch: ${list.slice(0, 5).join(', ')}${list.length > 5 ? ` (+${list.length - 5} more)` : ''}. Each IMEI can only be scanned once.`
      );
    }
    const incomingSerials = input.imeis.map(i => i.serialNo).filter((v): v is string => !!v);
    const dupSerials = incomingSerials.filter((v, idx) => incomingSerials.indexOf(v) !== idx);
    if (dupSerials.length) {
      throw new BadRequestError(`Duplicate Sr. No. in this batch: ${[...new Set(dupSerials)].slice(0, 5).join(', ')}. Each serial can only be scanned once.`);
    }
    const existing = await prisma.imeiInventory.findMany({
      where: {
        isDeleted: false,
        OR: [
          { imei1: { in: incoming } },
          { serialNo: { in: incoming } },
          ...(incomingSerials.length ? [{ serialNo: { in: incomingSerials } }, { imei1: { in: incomingSerials } }] : []),
        ],
      },
      select: { imei1: true, serialNo: true, status: true, product: { select: { model: true } } },
    });
    if (existing.length) {
      const detail = existing.slice(0, 5)
        .map(e => `${e.imei1} (already in stock as ${e.product?.model ?? 'another product'})`)
        .join('; ');
      throw new BadRequestError(
        `${existing.length} IMEI(s) already exist in the system: ${detail}${existing.length > 5 ? ` (+${existing.length - 5} more)` : ''}. Remove these rows and save again.`
      );
    }

    const result = await prisma.$transaction(async (tx) => {
      // Create the InventoryTransaction FIRST so we get its ID to link to IMEI records
      // Opening Stock sends type:'OPENING' so these show up in the Opening
      // Stock "View & Manage" tab (which filters by type=OPENING) instead of
      // being mixed into the regular Stock In history.
      const txnType = (input as any).type === 'OPENING' ? TransactionType.OPENING : TransactionType.STOCK_IN;
      const move = await applyLedgerMovementTx(tx, {
        productId: input.productId,
        warehouseId: input.warehouseId,
        type: txnType,
        signedQty: input.imeis.length,
        vendorId: input.vendorId ?? (input as any).vendorId ?? null,
        // The invoice belongs on the transaction, not buried in the remarks
        // text, so it can be read back when the entry is reopened or exported.
        referenceType: (input as any).invoiceNo ? 'INVOICE' : 'IMEI_RECEIVE',
        referenceId: (input as any).invoiceNo ?? null,
        remarks: input.remarks ?? null,
        occurredAt: parseDispatchDate((input as any).txnDate),
      }, actor);
      // Create IMEI records linked to this exact transaction — enables time-independent edit
      await imeiRepository.createReceived(
        tx, input.productId, input.warehouseId, input.imeis,
        actor.id, (input as any).vendorId, move.transactionId,
        parseDispatchDate((input as any).txnDate) ?? undefined,
      );
      // strict: same-tx writes must reconcile, or we roll back.
      await assertConsistentTx(tx, input.productId, input.warehouseId, true, { strict: true });
      return move;
    }, {
      // Large entries do several round trips per product group. The default 5s
      // interactive-transaction limit aborts them mid-way, which surfaced as an
      // unexplained internal error on big dispatches.
      timeout: 120_000,
      maxWait: 20_000,
    });

    emitStockChanged({ productId: input.productId, warehouseId: input.warehouseId, quantity: result.newQuantity, type: 'STOCK_IN' });
    return { received: input.imeis.length, newQuantity: result.newQuantity };
  },

  // Sell / dispatch specific IMEIs. Locks them, validates availability, marks
  // SOLD, and applies one outbound ledger movement per (product, warehouse).
  async dispatch(input: DispatchImeiInput, actor: Actor) {
    const type = input.channel === 'MARKETPLACE'
      ? TransactionType.MARKETPLACE_DISPATCH
      : TransactionType.STOCK_OUT;

    const groups = await prisma.$transaction(async (tx) => {
      const scanned = await resolveCodes(tx, input.imeis);
      const locked = await imeiRepository.lockByImei1(tx, scanned);
      const foundSet = new Set(locked.map((r) => r.imei1));
      const missing = scanned.filter((i) => !foundSet.has(i));
      if (missing.length) throw new BadRequestError(
        `IMEI / Sr. No. not found in IMEI Tracker — these units were never scanned in:\n${missing.join(', ')}\n\nScan them in via Stock In first, or remove them from this dispatch.`,
        { missing },
      );

      const unavailable = locked.filter((r) => !isInStock(r.status));
      if (unavailable.length) {
        throw new BadRequestError('IMEI(s) not available for dispatch', {
          items: unavailable.map((r) => ({ imei: r.imei1, status: r.status })),
        });
      }

      await imeiRepository.setStatus(tx, locked.map((r) => r.id), ImeiStatus.SOLD, actor.id);

      // Keep a serial typed at Stock Out. Only fills an empty serialNo — a
      // serial recorded at Stock In is never overwritten.
      const serials = (input as any).serials as { code: string; serialNo: string }[] | undefined;
      if (serials?.length) {
        const byCode = new Map(serials.map(s => [s.code.trim(), s.serialNo.trim()]));
        const lockedIds = locked.map((r) => r.id);
        const current = await tx.imeiInventory.findMany({
          where: { id: { in: lockedIds } }, select: { id: true, imei1: true, serialNo: true },
        });
        for (const u of current) {
          const sn = byCode.get(u.imei1);
          if (sn && !u.serialNo && sn !== u.imei1) {
            await tx.imeiInventory.update({ where: { id: u.id }, data: { serialNo: sn } });
          }
        }
      }

      const byGroup = new Map<string, LockedImei[]>();
      for (const r of locked) {
        const key = `${r.productId}::${r.warehouseId}`;
        (byGroup.get(key) ?? byGroup.set(key, []).get(key)!).push(r);
      }

      const out: { productId: string; warehouseId: string; count: number; newQuantity: number }[] = [];
      for (const [key, rows] of byGroup) {
        const [productId, warehouseId] = key.split('::');
        const move = await applyLedgerMovementTx(tx, {
          productId, warehouseId, type,
          signedQty: -rows.length,
          remarks: input.remarks ?? null,
          // Recorded against the customer and the date the goods actually left,
          // not against nobody on whatever day the entry was typed.
          vendorId: (input as any).vendorId ?? null,
          // An invoice number takes precedence over the generic dispatch marker;
          // duplicate keys here previously made the intent unreadable.
          referenceType: (input as any).invoiceNo ? 'INVOICE' : (input.referenceType ?? 'IMEI_DISPATCH'),
          referenceId: (input as any).invoiceNo ?? input.referenceId ?? null,
          occurredAt: parseDispatchDate((input as any).txnDate),
        }, actor);

        // Link each dispatched unit to the transaction that sold it. Without
        // this the only way back was a time window around the entry date, which
        // fails the moment an entry is backdated — the edit screen and the
        // per-entry export both came up empty for Stock Out because of it.
        await tx.imeiInventory.updateMany({
          where: { id: { in: rows.map((r: any) => r.id) } },
          data: { stockOutTxnId: move.transactionId ?? null },
        });

        await assertConsistentTx(tx, productId, warehouseId, true, { strict: true });
        out.push({ productId, warehouseId, count: rows.length, newQuantity: move.newQuantity });
      }
      return out;
    }, {
      // Large entries do several round trips per product group. The default 5s
      // interactive-transaction limit aborts them mid-way, which surfaced as an
      // unexplained internal error on big dispatches.
      timeout: 120_000,
      maxWait: 20_000,
    });

    for (const g of groups) {
      emitStockChanged({ productId: g.productId, warehouseId: g.warehouseId, quantity: g.newQuantity, type });
    }
    return { dispatched: input.imeis.length, groups };
  },

  // Operator status transition (block / damage / open-box / return / restock).
  async changeStatus(imei: string, target: ImeiStatus, reason: string | undefined, actor: Actor, swiped?: boolean) {
    const result = await prisma.$transaction(async (tx) => {
      const [row] = await imeiRepository.lockByImei1(tx, [imei]);
      if (!row) throw new NotFoundError(`IMEI ${imei} not found`);
      if (row.status === target) return { imei, from: row.status, to: target, stockDelta: 0, productId: row.productId, warehouseId: row.warehouseId, newQuantity: null as number | null };

      // A unit already sold to a customer is locked here. This endpoint moves
      // the ledger directly (a RETURN or ADJUSTMENT entry with no paperwork
      // behind it) — reversing an actual sale belongs to a proper return
      // process, not a status dropdown. Enforced here too, not just hidden in
      // the UI, so the rule holds regardless of how the request was made.
      if (row.status === ('SOLD' as ImeiStatus)) {
        throw new BadRequestError(
          'This unit has been sold and its status is locked. Reverse the Stock Out entry it was dispatched on instead of changing status directly.',
        );
      }

      const delta = statusStockDelta(row.status, target);
      await imeiRepository.setStatus(tx, [row.id], target, actor.id);
      // Update swiped flag if provided; record timestamp when swiping on
      if (swiped !== undefined) {
        await tx.imeiInventory.update({
          where: { id: row.id },
          data: { swiped, swipedAt: swiped ? new Date() : null, updatedBy: actor.id },
        });
      }

      let newQuantity: number | null = null;
      if (delta !== 0) {
        const move = await applyLedgerMovementTx(tx, {
          productId: row.productId,
          warehouseId: row.warehouseId,
          // +1 (back to sellable) = RETURN; -1 (out of sellable) = ADJUSTMENT
          type: delta > 0 ? TransactionType.RETURN : TransactionType.ADJUSTMENT,
          signedQty: delta,
          referenceType: 'IMEI_STATUS',
          remarks: reason ?? `status ${row.status} -> ${target}`,
        }, actor);
        newQuantity = move.newQuantity;
      }

      await writeAudit(tx, {
        userId: actor.id, action: 'UPDATE', entityName: 'imei_inventory', entityId: row.id,
        oldValue: { status: row.status }, newValue: { status: target, reason }, ipAddress: actor.ip,
      });
      await assertConsistentTx(tx, row.productId, row.warehouseId, true, { strict: true });
      return { imei, from: row.status, to: target, stockDelta: delta, productId: row.productId, warehouseId: row.warehouseId, newQuantity };
    }, {
      // Large entries do several round trips per product group. The default 5s
      // interactive-transaction limit aborts them mid-way, which surfaced as an
      // unexplained internal error on big dispatches.
      timeout: 120_000,
      maxWait: 20_000,
    });

    if (result.stockDelta !== 0 && result.newQuantity !== null) {
      emitStockChanged({ productId: result.productId, warehouseId: result.warehouseId, quantity: result.newQuantity, type: 'IMEI_STATUS' });
    }
    return result;
  },

  async lookup(imei: string) {
    const row = await imeiRepository.findByImei1(imei);
    if (!row) throw new NotFoundError(`IMEI ${imei} not found`);

    // Who supplied it, and — for a sold unit — when and to whom it went. The
    // Stock In screen uses this to tell a genuine duplicate scan from a
    // customer return, and says which it is instead of a bare "duplicate".
    const full = await prisma.imeiInventory.findUnique({
      where: { id: row.id },
      select: { stockOutTxnId: true, supplier: { select: { name: true } } },
    });
    let sale: { date: string; customer: string | null } | null = null;
    if (row.status === ImeiStatus.SOLD && full?.stockOutTxnId) {
      const t = await prisma.inventoryTransaction.findUnique({
        where: { id: full.stockOutTxnId },
        select: { createdAt: true, vendor: { select: { name: true } } },
      });
      if (t) sale = { date: t.createdAt.toISOString(), customer: t.vendor?.name ?? null };
    }
    return { ...row, supplier: full?.supplier ?? null, sale };
  },

  // Take sold units back into stock as a customer return.
  //
  // A sold unit still exists in the tracker with status SOLD, so receiving it
  // again is rejected as a duplicate — which is correct for a genuine double
  // scan but made returns impossible to record. A return is its own movement:
  // the unit flips back to IN_STOCK, one RETURN is written to the ledger, and
  // the sale it undoes is remembered so Product History can show the whole
  // story (sold, then returned) instead of losing the first half.
  async returnUnits(
    input: { imeis: string[]; vendorId?: string; txnDate?: string; invoiceNo?: string; remarks?: string },
    actor: Actor,
  ) {
    const codes = [...new Set(input.imeis.map(i => i.trim()).filter(Boolean))];
    if (!codes.length) throw new BadRequestError('No units to return');

    const results: { productId: string; warehouseId: string; count: number; newQuantity: number }[] = [];

    await prisma.$transaction(async (tx) => {
      const scanned = await resolveCodes(tx, codes);
      const locked = await imeiRepository.lockByImei1(tx, scanned);
      const found = new Set(locked.map(r => r.imei1));
      const missing = scanned.filter(c => !found.has(c));
      if (missing.length) {
        throw new BadRequestError(
          `Not in the tracker: ${missing.join(', ')}. A return can only be recorded for a unit that was sold from here — ` +
          `use a normal Stock In for new stock.`,
        );
      }
      const notSold = locked.filter(r => r.status !== ImeiStatus.SOLD);
      if (notSold.length) {
        throw new BadRequestError(
          `Cannot record a return — not currently sold: ${notSold.map(r => `${r.imei1} (${r.status.replace(/_/g, ' ')})`).join(', ')}.`,
        );
      }

      // The sale each unit is currently attached to, so it can be remembered.
      const links = await tx.imeiInventory.findMany({
        where: { id: { in: locked.map(r => r.id) } },
        select: { id: true, stockOutTxnId: true },
      });
      const saleTxnOf = new Map(links.map(l => [l.id, l.stockOutTxnId]));

      const groups = new Map<string, typeof locked>();
      for (const r of locked) {
        const k = `${r.productId}::${r.warehouseId}`;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k)!.push(r);
      }

      for (const [k, rows] of groups) {
        const [productId, warehouseId] = k.split('::');
        const move = await applyLedgerMovementTx(tx, {
          productId, warehouseId,
          type: TransactionType.RETURN,
          signedQty: rows.length,
          vendorId: input.vendorId ?? null,
          referenceType: input.invoiceNo ? 'INVOICE' : 'IMEI_RETURN',
          referenceId: input.invoiceNo ?? null,
          remarks: input.remarks ?? 'Customer return',
          occurredAt: parseDispatchDate(input.txnDate),
        }, actor);

        for (const r of rows) {
          const saleTxn = saleTxnOf.get(r.id) ?? null;
          if (saleTxn) {
            await recordImeiEvent(tx, { imeiId: r.id, imei1: r.imei1, productId, eventType: 'SOLD', txnId: saleTxn, actorId: actor.id });
          }
          await recordImeiEvent(tx, { imeiId: r.id, imei1: r.imei1, productId, eventType: 'RETURNED', txnId: move.transactionId, actorId: actor.id });
        }

        await tx.imeiInventory.updateMany({
          where: { id: { in: rows.map(r => r.id) } },
          data: { status: ImeiStatus.IN_STOCK, stockOutTxnId: null, updatedBy: actor.id },
        });

        await writeAudit(tx, {
          userId: actor.id, action: 'UPDATE', entityName: 'imei_inventory', entityId: rows[0].id,
          oldValue: { status: 'SOLD', imeis: rows.map(r => r.imei1) },
          newValue: { status: 'IN_STOCK', event: 'CUSTOMER_RETURN', transactionId: move.transactionId },
          ipAddress: actor.ip,
        });

        // Units and level must still agree after the return.
        await assertConsistentTx(tx, productId, warehouseId, true, { strict: true });
        results.push({ productId, warehouseId, count: rows.length, newQuantity: move.newQuantity });
      }
    }, { timeout: 120_000, maxWait: 20_000 });

    for (const r of results) {
      emitStockChanged({ productId: r.productId, warehouseId: r.warehouseId, quantity: r.newQuantity, type: 'STOCK_IN' });
    }
    return { returned: codes.length, groups: results };
  },

  async list(input: {
    status?: ImeiStatus; productId?: string; warehouseId?: string; search?: string;
    brand?: string; categoryId?: string; page: number; limit: number;
  }) {
    const [items, total] = await imeiRepository.list({
      status: input.status, productId: input.productId, warehouseId: input.warehouseId,
      search: input.search,
      brand:      input.brand      || undefined,
      categoryId: input.categoryId || undefined,
      imeiType:  (input as any).imeiType  || undefined,
      swiped:    (input as any).swiped    === 'true' ? true : (input as any).swiped    === 'false' ? false : undefined,
      activated: (input as any).activated === 'true' ? true : (input as any).activated === 'false' ? false : undefined,
      skip: (input.page - 1) * input.limit, take: input.limit,
    });
    return { items, page: input.page, limit: input.limit, total, totalPages: Math.ceil(total / input.limit) };
  },
};
