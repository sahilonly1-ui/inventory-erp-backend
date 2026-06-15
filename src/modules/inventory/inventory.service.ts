import { Prisma, TransactionType } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { BadRequestError, NotFoundError } from '../../common/errors';
import { writeAudit } from '../../common/audit.service';
import { emitStockChanged } from '../../common/events';
import { inventoryRepository as repo } from './inventory.repository';
import { imeiRepository } from '../imei/imei.repository';
import { Actor, LedgerMovementParams, MovementResult, EanLookupResult } from './inventory.dto';

const INBOUND = new Set<TransactionType>([
  TransactionType.STOCK_IN,
  TransactionType.RETURN,
  TransactionType.CANCELLATION,
  TransactionType.TRANSFER_IN,
  TransactionType.OPENING,
]);
const OUTBOUND = new Set<TransactionType>([
  TransactionType.STOCK_OUT,
  TransactionType.MARKETPLACE_DISPATCH,
  TransactionType.TRANSFER_OUT,
]);

// Resolves a magnitude to a signed ledger delta based on movement direction.
// ADJUSTMENT carries an already-signed quantity from the caller.
export function toSigned(type: TransactionType, magnitude: number): number {
  if (type === TransactionType.ADJUSTMENT) return magnitude;
  if (INBOUND.has(type)) return Math.abs(magnitude);
  if (OUTBOUND.has(type)) return -Math.abs(magnitude);
  throw new BadRequestError(`Unsupported movement type ${type}`);
}

// THE single ledger primitive. Locks the stock row, applies the delta, writes
// the immutable ledger row, and audits — all on the caller's transaction so it
// composes with IMEI changes, transfers, and (later) marketplace flows.
export async function applyLedgerMovementTx(
  tx: Prisma.TransactionClient,
  params: LedgerMovementParams,
  actor: Actor,
): Promise<MovementResult> {
  const newQuantity = await repo.lockAndApplyDelta(tx, params.productId, params.warehouseId, params.signedQty);
  const txn = await repo.recordTransaction(tx, { ...params, createdBy: actor.id });
  await writeAudit(tx, {
    userId: actor.id,
    action: 'CREATE',
    entityName: 'inventory_transactions',
    entityId: txn.id,
    newValue: {
      type: params.type,
      quantity: params.signedQty,
      productId: params.productId,
      warehouseId: params.warehouseId,
    },
    ipAddress: actor.ip,
  });
  return { newQuantity, transactionId: txn.id };
}

async function ensureNonImeiProduct(productId: string) {
  const product = await repo.findActiveProduct(productId);
  if (!product) throw new NotFoundError('Product not found');
  if (product.imeiRequired) {
    throw new BadRequestError('This product is IMEI-tracked; use the /imei endpoints');
  }
  return product;
}

export const inventoryService = {
  async stockIn(input: {
    productId: string; warehouseId: string; quantity: number;
    unitCost?: number; vendorId?: string; remarks?: string;
  }, actor: Actor): Promise<MovementResult> {
    await ensureNonImeiProduct(input.productId);
    const result = await prisma.$transaction((tx) =>
      applyLedgerMovementTx(tx, {
        productId: input.productId,
        warehouseId: input.warehouseId,
        type: TransactionType.STOCK_IN,
        signedQty: toSigned(TransactionType.STOCK_IN, input.quantity),
        unitCost: input.unitCost ?? null,
        vendorId: input.vendorId ?? null,
        remarks: input.remarks ?? null,
      }, actor),
    );
    emitStockChanged({ productId: input.productId, warehouseId: input.warehouseId, quantity: result.newQuantity, type: 'STOCK_IN' });
    return result;
  },

  async stockOut(input: {
    productId: string; warehouseId: string; quantity: number; remarks?: string;
  }, actor: Actor): Promise<MovementResult> {
    await ensureNonImeiProduct(input.productId);
    const result = await prisma.$transaction((tx) =>
      applyLedgerMovementTx(tx, {
        productId: input.productId,
        warehouseId: input.warehouseId,
        type: TransactionType.STOCK_OUT,
        signedQty: toSigned(TransactionType.STOCK_OUT, input.quantity),
        remarks: input.remarks ?? null,
      }, actor),
    );
    emitStockChanged({ productId: input.productId, warehouseId: input.warehouseId, quantity: result.newQuantity, type: 'STOCK_OUT' });
    return result;
  },

  async adjust(input: {
    productId: string; warehouseId: string; quantity: number; reason: string;
  }, actor: Actor): Promise<MovementResult> {
    await ensureNonImeiProduct(input.productId);
    const result = await prisma.$transaction((tx) =>
      applyLedgerMovementTx(tx, {
        productId: input.productId,
        warehouseId: input.warehouseId,
        type: TransactionType.ADJUSTMENT,
        signedQty: input.quantity, // already signed
        remarks: input.reason,
      }, actor),
    );
    emitStockChanged({ productId: input.productId, warehouseId: input.warehouseId, quantity: result.newQuantity, type: 'ADJUSTMENT' });
    return result;
  },

  // Opening stock — registers a product in a warehouse without IMEI check.
  // Used for bulk catalogue mapping. IMEI-tracked phones are registered at
  // qty 0 (no physical units tracked yet) via a ledger OPENING entry.
  async openingStock(input: {
    productId: string; warehouseId: string; quantity: number; unitCost?: number;
  }, actor: Actor): Promise<MovementResult> {
    // Skip ensureNonImeiProduct — opening stock works for ALL product types
    const product = await repo.findActiveProduct(input.productId);
    if (!product) throw new NotFoundError('Product not found');
    const result = await prisma.$transaction((tx) =>
      applyLedgerMovementTx(tx, {
        productId: input.productId,
        warehouseId: input.warehouseId,
        type: TransactionType.OPENING,
        signedQty: input.quantity,
        unitCost: input.unitCost ?? null,
        vendorId: null,
        remarks: 'Opening stock — warehouse mapping',
      }, actor),
    );
    emitStockChanged({ productId: input.productId, warehouseId: input.warehouseId, quantity: result.newQuantity, type: 'STOCK_IN' });
    return result;
  },

  // Reset ALL stock levels to zero (for initial setup)
  async resetAllStock(actor: Actor): Promise<{ reset: number }> {
    const result = await prisma.stockLevel.updateMany({ data: { quantity: 0 } });
    await writeAudit(prisma as any, {
      userId: actor.id, action: 'UPDATE', entityName: 'inventory',
      entityId: 'all', newValue: { action: 'reset_all_to_zero' }, ipAddress: actor.ip,
    });
    return { reset: result.count };
  },

  // Atomic warehouse transfer = one TRANSFER_OUT + one TRANSFER_IN sharing a
  // transferId. Locks are acquired in a deterministic warehouse order to avoid
  // deadlocks between opposing concurrent transfers.
  async transfer(input: {
    productId: string; fromWarehouseId: string; toWarehouseId: string;
    quantity: number; imeis?: string[]; remarks?: string;
  }, actor: Actor) {
    const product = await repo.findActiveProduct(input.productId);
    if (!product) throw new NotFoundError('Product not found');
    if (product.imeiRequired && (!input.imeis || input.imeis.length !== input.quantity)) {
      throw new BadRequestError('IMEI-tracked transfer requires an imeis[] list matching quantity');
    }

    const transferId = `transfer:${Date.now()}:${input.productId}`;
    const legs = [
      { warehouseId: input.fromWarehouseId, signedQty: -input.quantity, type: TransactionType.TRANSFER_OUT },
      { warehouseId: input.toWarehouseId, signedQty: input.quantity, type: TransactionType.TRANSFER_IN },
    ].sort((a, b) => a.warehouseId.localeCompare(b.warehouseId)); // stable lock order

    const result = await prisma.$transaction(async (tx) => {
      const moves: Record<string, MovementResult> = {};
      for (const leg of legs) {
        moves[leg.warehouseId] = await applyLedgerMovementTx(tx, {
          productId: input.productId,
          warehouseId: leg.warehouseId,
          type: leg.type,
          signedQty: leg.signedQty,
          referenceType: 'TRANSFER',
          referenceId: transferId,
          remarks: input.remarks ?? null,
        }, actor);
      }

      if (product.imeiRequired && input.imeis?.length) {
        const locked = await imeiRepository.lockByImei1(tx, input.imeis);
        const offSource = locked.filter((r) => r.warehouseId !== input.fromWarehouseId || r.status !== 'IN_STOCK');
        if (locked.length !== input.imeis.length || offSource.length) {
          throw new BadRequestError('One or more IMEIs are not in-stock at the source warehouse', {
            problem: offSource.map((r) => ({ imei: r.imei1, status: r.status, warehouseId: r.warehouseId })),
          });
        }
        await imeiRepository.moveWarehouse(tx, locked.map((r) => r.id), input.toWarehouseId, actor.id);
      }
      return moves;
    });

    emitStockChanged({ productId: input.productId, warehouseId: input.fromWarehouseId, quantity: result[input.fromWarehouseId].newQuantity, type: 'TRANSFER_OUT' });
    emitStockChanged({ productId: input.productId, warehouseId: input.toWarehouseId, quantity: result[input.toWarehouseId].newQuantity, type: 'TRANSFER_IN' });
    return {
      transferId,
      from: { warehouseId: input.fromWarehouseId, newQuantity: result[input.fromWarehouseId].newQuantity },
      to: { warehouseId: input.toWarehouseId, newQuantity: result[input.toWarehouseId].newQuantity },
    };
  },

  async getStock(input: { productId?: string; warehouseId?: string; page: number; limit: number }) {
    const [items, total] = await repo.listStockLevels({
      productId: input.productId,
      warehouseId: input.warehouseId,
      skip: (input.page - 1) * input.limit,
      take: input.limit,
    });
    return {
      items: items.map((s) => ({
        productId: s.productId,
        warehouseId: s.warehouseId,
        warehouseName: s.warehouse.name,
        quantity: s.quantity,
        updatedAt: s.updatedAt,
      })),
      page: input.page, limit: input.limit, total, totalPages: Math.ceil(total / input.limit),
    };
  },

  async getLedger(input: {
    productId?: string; warehouseId?: string; type?: TransactionType;
    from?: Date; to?: Date; page: number; limit: number;
  }) {
    const [items, total] = await repo.listLedger({
      productId: input.productId, warehouseId: input.warehouseId, type: input.type,
      from: input.from, to: input.to,
      skip: (input.page - 1) * input.limit, take: input.limit,
    });
    return { items, page: input.page, limit: input.limit, total, totalPages: Math.ceil(total / input.limit) };
  },

  // EAN scanner step: lookup -> product + live stock across warehouses.
  async lookupByEan(ean: string): Promise<EanLookupResult> {
    const product = await repo.findProductByEan(ean);
    if (!product) throw new NotFoundError(`No active product for EAN ${ean}`);
    const levels = await repo.stockByProduct(product.id);
    return {
      product: {
        id: product.id, ean: product.ean, sku: product.sku,
        model: product.model, brand: product.brand, imeiRequired: product.imeiRequired,
      },
      total: levels.reduce((sum, l) => sum + l.quantity, 0),
      byWarehouse: levels.map((l) => ({
        productId: product.id, warehouseId: l.warehouseId,
        warehouseName: l.warehouse.name, quantity: l.quantity,
      })),
    };
  },
};
