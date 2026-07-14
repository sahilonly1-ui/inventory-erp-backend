import { ImeiStatus, TransactionType } from '@prisma/client';
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

// Availability is defined as IMEI status === IN_STOCK. A status change shifts
// StockLevel by the change in IN_STOCK membership, keeping all three counts equal.
export const isInStock = (s: ImeiStatus): boolean => s === ImeiStatus.IN_STOCK;
export function statusStockDelta(from: ImeiStatus, to: ImeiStatus): number {
  return (isInStock(to) ? 1 : 0) - (isInStock(from) ? 1 : 0);
}

export const imeiService = {
  // Stock-in for IMEI products: create units + ledger inbound, same transaction.
  async receive(input: ReceiveImeiInput, actor: Actor) {
    const product = await inventoryRepository.findActiveProduct(input.productId);
    if (!product) throw new NotFoundError('Product not found');
    if (!product.imeiRequired && !(input as any).force) {
      throw new BadRequestError('Product is not IMEI-tracked; use /inventory/stock-in');
    }

    const result = await prisma.$transaction(async (tx) => {
      await imeiRepository.createReceived(tx, input.productId, input.warehouseId, input.imeis, actor.id, (input as any).vendorId);
      const move = await applyLedgerMovementTx(tx, {
        productId: input.productId,
        warehouseId: input.warehouseId,
        type: TransactionType.STOCK_IN,
        signedQty: input.imeis.length,
        referenceType: 'IMEI_RECEIVE',
        remarks: input.remarks ?? null,
      }, actor);
      // strict: same-tx writes must reconcile, or we roll back.
      await assertConsistentTx(tx, input.productId, input.warehouseId, true, { strict: true });
      return move;
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
      const locked = await imeiRepository.lockByImei1(tx, input.imeis);
      const foundSet = new Set(locked.map((r) => r.imei1));
      const missing = input.imeis.filter((i) => !foundSet.has(i));
      if (missing.length) throw new BadRequestError('Unknown IMEI(s)', { missing });

      const unavailable = locked.filter((r) => !isInStock(r.status));
      if (unavailable.length) {
        throw new BadRequestError('IMEI(s) not available for dispatch', {
          items: unavailable.map((r) => ({ imei: r.imei1, status: r.status })),
        });
      }

      await imeiRepository.setStatus(tx, locked.map((r) => r.id), ImeiStatus.SOLD, actor.id);

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
          referenceType: input.referenceType ?? 'IMEI_DISPATCH',
          referenceId: input.referenceId ?? null,
          remarks: input.remarks ?? null,
        }, actor);
        await assertConsistentTx(tx, productId, warehouseId, true, { strict: true });
        out.push({ productId, warehouseId, count: rows.length, newQuantity: move.newQuantity });
      }
      return out;
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
    });

    if (result.stockDelta !== 0 && result.newQuantity !== null) {
      emitStockChanged({ productId: result.productId, warehouseId: result.warehouseId, quantity: result.newQuantity, type: 'IMEI_STATUS' });
    }
    return result;
  },

  async lookup(imei: string) {
    const row = await imeiRepository.findByImei1(imei);
    if (!row) throw new NotFoundError(`IMEI ${imei} not found`);
    return row;
  },

  async list(input: {
    status?: ImeiStatus; productId?: string; warehouseId?: string; search?: string;
    page: number; limit: number;
  }) {
    const [items, total] = await imeiRepository.list({
      status: input.status, productId: input.productId, warehouseId: input.warehouseId,
      search: input.search, skip: (input.page - 1) * input.limit, take: input.limit,
    });
    return { items, page: input.page, limit: input.limit, total, totalPages: Math.ceil(total / input.limit) };
  },
};
