import { ImeiStatus, MarketplaceOrderStatus, Prisma, TransactionType } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { BadRequestError, NotFoundError } from '../../common/errors';
import { writeAudit } from '../../common/audit.service';
import { emitStockChanged } from '../../common/events';
import { applyLedgerMovementTx } from '../inventory/inventory.service';
import { assertConsistentTx } from '../inventory/reconciliation.service';
import { imeiRepository } from '../imei/imei.repository';

interface Actor { id: string; ip: string | null; }

type OrderInput = {
  marketplace: Prisma.MarketplaceOrderUncheckedCreateInput['marketplace'];
  orderNumber: string;
  shipmentNumber?: string;
  items: { sku: string; ean: string; quantity: number; imei?: string }[];
};

// Resolve EAN -> product once and reuse.
async function productByEan(tx: Prisma.TransactionClient, ean: string) {
  const p = await tx.product.findFirst({ where: { ean, isDeleted: false } });
  if (!p) throw new BadRequestError(`No active product for EAN ${ean}`);
  return p;
}

export const marketplaceService = {
  // Bulk import / create. Duplicate (marketplace, orderNumber) pairs are skipped.
  async createOrders(orders: OrderInput[], actor: Actor) {
    const created: string[] = [];
    const skipped: string[] = [];
    for (const o of orders) {
      try {
        const order = await prisma.marketplaceOrder.create({
          data: {
            marketplace: o.marketplace,
            orderNumber: o.orderNumber,
            shipmentNumber: o.shipmentNumber ?? null,
            createdBy: actor.id,
            items: { create: o.items.map((i) => ({ sku: i.sku, ean: i.ean, quantity: i.quantity, imei: i.imei ?? null })) },
          },
        });
        created.push(order.id);
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          skipped.push(`${o.marketplace}:${o.orderNumber}`);
        } else throw e;
      }
    }
    return { created: created.length, skipped };
  },

  // Fulfil an order from a warehouse: outbound movement per item (IMEI items
  // dispatch their specific unit) — all atomic.
  async dispatch(orderId: string, warehouseId: string, actor: Actor) {
    const result = await prisma.$transaction(async (tx) => {
      const order = await tx.marketplaceOrder.findFirst({ where: { id: orderId, isDeleted: false }, include: { items: true } });
      if (!order) throw new NotFoundError('Order not found');
      if (!([MarketplaceOrderStatus.PENDING, MarketplaceOrderStatus.CONFIRMED] as string[]).includes(order.status)) {
        throw new BadRequestError(`Order cannot be dispatched from status ${order.status}`);
      }

      const touched: { productId: string; warehouseId: string; quantity: number }[] = [];
      for (const it of order.items) {
        const product = await productByEan(tx, it.ean);

        if (product.imeiRequired) {
          if (!it.imei) throw new BadRequestError(`Order item ${it.ean} is IMEI-tracked but has no IMEI`);
          const [unit] = await imeiRepository.lockByImei1(tx, [it.imei]);
          if (!unit || unit.status !== ImeiStatus.IN_STOCK || unit.warehouseId !== warehouseId) {
            throw new BadRequestError(`IMEI ${it.imei} is not in stock at this warehouse`);
          }
          await imeiRepository.setStatus(tx, [unit.id], ImeiStatus.SOLD, actor.id);
        }

        const move = await applyLedgerMovementTx(tx, {
          productId: product.id, warehouseId, type: TransactionType.MARKETPLACE_DISPATCH,
          signedQty: -it.quantity, referenceType: 'MARKETPLACE_ORDER', referenceId: order.id,
          remarks: `${order.marketplace} ${order.orderNumber}`,
        }, actor);
        if (product.imeiRequired) await assertConsistentTx(tx, product.id, warehouseId, true, { strict: true });
        touched.push({ productId: product.id, warehouseId, quantity: move.newQuantity });
      }

      await tx.marketplaceOrder.update({ where: { id: order.id }, data: { status: MarketplaceOrderStatus.DISPATCHED, updatedBy: actor.id } });
      await writeAudit(tx, { userId: actor.id, action: 'UPDATE', entityName: 'marketplace_orders', entityId: order.id, newValue: { status: 'DISPATCHED', warehouseId }, ipAddress: actor.ip });
      return touched;
    });

    for (const t of result) emitStockChanged({ productId: t.productId, warehouseId: t.warehouseId, quantity: t.quantity, type: 'MARKETPLACE_DISPATCH' });
    return { orderId, status: 'DISPATCHED', items: result.length };
  },

  // Cancel: if already dispatched, reverse stock back in (CANCELLATION inbound).
  async cancel(orderId: string, reason: string | undefined, actor: Actor) {
    await prisma.$transaction(async (tx) => {
      const order = await tx.marketplaceOrder.findFirst({ where: { id: orderId, isDeleted: false }, include: { items: true } });
      if (!order) throw new NotFoundError('Order not found');
      if (order.status === MarketplaceOrderStatus.CANCELLED) throw new BadRequestError('Order already cancelled');

      if (order.status === MarketplaceOrderStatus.DISPATCHED) {
        for (const it of order.items) {
          const product = await productByEan(tx, it.ean);
          // figure out the warehouse the dispatch came from via the last dispatch txn
          const lastDispatch = await tx.inventoryTransaction.findFirst({
            where: { productId: product.id, referenceType: 'MARKETPLACE_ORDER', referenceId: order.id, type: TransactionType.MARKETPLACE_DISPATCH },
            orderBy: { createdAt: 'desc' },
          });
          const warehouseId = lastDispatch?.warehouseId;
          if (!warehouseId) continue;
          if (product.imeiRequired && it.imei) {
            const [unit] = await imeiRepository.lockByImei1(tx, [it.imei]);
            if (unit) await imeiRepository.setStatus(tx, [unit.id], ImeiStatus.IN_STOCK, actor.id);
          }
          await applyLedgerMovementTx(tx, {
            productId: product.id, warehouseId, type: TransactionType.CANCELLATION,
            signedQty: it.quantity, referenceType: 'MARKETPLACE_ORDER', referenceId: order.id, remarks: reason ?? 'cancellation',
          }, actor);
          if (product.imeiRequired) await assertConsistentTx(tx, product.id, warehouseId, true, { strict: true });
        }
      }

      await tx.cancellation.create({ data: { orderId: order.id, reason: reason ?? null, createdBy: actor.id } });
      await tx.marketplaceOrder.update({ where: { id: order.id }, data: { status: MarketplaceOrderStatus.CANCELLED, updatedBy: actor.id } });
      await writeAudit(tx, { userId: actor.id, action: 'UPDATE', entityName: 'marketplace_orders', entityId: order.id, newValue: { status: 'CANCELLED', reason }, ipAddress: actor.ip });
    });
    return { orderId, status: 'CANCELLED' };
  },

  // Customer return: RETURN inbound for the returned items.
  async returnOrder(orderId: string, reason: string | undefined, items: { ean: string; quantity: number; imei?: string }[] | undefined, actor: Actor) {
    await prisma.$transaction(async (tx) => {
      const order = await tx.marketplaceOrder.findFirst({ where: { id: orderId, isDeleted: false }, include: { items: true } });
      if (!order) throw new NotFoundError('Order not found');

      const returns = items ?? order.items.map((i) => ({ ean: i.ean, quantity: i.quantity, imei: i.imei ?? undefined }));
      for (const r of returns) {
        const product = await productByEan(tx, r.ean);
        const lastDispatch = await tx.inventoryTransaction.findFirst({
          where: { productId: product.id, referenceType: 'MARKETPLACE_ORDER', referenceId: order.id, type: TransactionType.MARKETPLACE_DISPATCH },
          orderBy: { createdAt: 'desc' },
        });
        const warehouseId = lastDispatch?.warehouseId;
        if (!warehouseId) continue;
        if (product.imeiRequired && r.imei) {
          const [unit] = await imeiRepository.lockByImei1(tx, [r.imei]);
          // returned units land as RETURNED (not auto-resellable) — restock is a separate IMEI action
          if (unit) await imeiRepository.setStatus(tx, [unit.id], ImeiStatus.RETURNED, actor.id);
        }
        // ledger RETURN inbound only when the unit re-enters sellable stock; for
        // IMEI returns it stays RETURNED, so we record a 0-effect audit instead.
        if (!product.imeiRequired) {
          await applyLedgerMovementTx(tx, {
            productId: product.id, warehouseId, type: TransactionType.RETURN,
            signedQty: r.quantity, referenceType: 'MARKETPLACE_ORDER', referenceId: order.id, remarks: reason ?? 'return',
          }, actor);
        }
        await tx.return.create({ data: { orderId: order.id, productId: product.id, imei: r.imei ?? null, quantity: r.quantity, reason: reason ?? null, createdBy: actor.id } });
      }

      await tx.marketplaceOrder.update({ where: { id: order.id }, data: { status: MarketplaceOrderStatus.RETURNED, updatedBy: actor.id } });
      await writeAudit(tx, { userId: actor.id, action: 'UPDATE', entityName: 'marketplace_orders', entityId: order.id, newValue: { status: 'RETURNED', reason }, ipAddress: actor.ip });
    });
    return { orderId, status: 'RETURNED' };
  },

  async list(input: { marketplace?: Prisma.MarketplaceOrderWhereInput['marketplace']; status?: Prisma.MarketplaceOrderWhereInput['status']; page: number; limit: number }) {
    const where: Prisma.MarketplaceOrderWhereInput = {
      isDeleted: false,
      ...(input.marketplace ? { marketplace: input.marketplace } : {}),
      ...(input.status ? { status: input.status } : {}),
    };
    const [items, total] = await prisma.$transaction([
      prisma.marketplaceOrder.findMany({ where, include: { items: true }, orderBy: { createdAt: 'desc' }, skip: (input.page - 1) * input.limit, take: input.limit }),
      prisma.marketplaceOrder.count({ where }),
    ]);
    return { items, page: input.page, limit: input.limit, total, totalPages: Math.ceil(total / input.limit) };
  },

  async get(id: string) {
    const order = await prisma.marketplaceOrder.findFirst({ where: { id, isDeleted: false }, include: { items: true, cancellation: true, returns: true } });
    if (!order) throw new NotFoundError('Order not found');
    return order;
  },
};
