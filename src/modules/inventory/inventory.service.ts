import { Prisma, TransactionType } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { BadRequestError, NotFoundError } from '../../common/errors';
import { writeAudit } from '../../common/audit.service';
import { emitStockChanged } from '../../common/events';
import { inventoryRepository as repo } from './inventory.repository';
import { imeiRepository } from '../imei/imei.repository';
import { Actor, LedgerMovementParams, MovementResult, EanLookupResult } from './inventory.dto';

/**
 * Turn a "YYYY-MM-DD" from the entry screen into a timestamp.
 *
 * Anchored at UTC noon, the same convention used for swipe/activation dates,
 * so the calendar day is identical no matter where it is displayed. Returns
 * null for today's entries so the database default applies.
 */
function parseTxnDate(d?: string | null): Date | null {
  if (!d) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d.trim());
  if (!m) return null;
  const when = new Date(`${d.trim()}T12:00:00.000Z`);
  return Number.isNaN(when.getTime()) ? null : when;
}

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

  // Auto-activate: if stock just came IN and the product was sitting INACTIVE,
  // bring it back to ACTIVE automatically — no point keeping a stocked item hidden.
  if (INBOUND.has(params.type) && newQuantity > 0) {
    await tx.product.updateMany({
      where: { id: params.productId, status: 'INACTIVE' },
      data: { status: 'ACTIVE', updatedBy: actor.id, updatedAt: new Date() },
    });
  }

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
    unitCost?: number; vendorId?: string; remarks?: string; txnDate?: string;
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
        occurredAt: parseTxnDate(input.txnDate),
      }, actor),
    );
    emitStockChanged({ productId: input.productId, warehouseId: input.warehouseId, quantity: result.newQuantity, type: 'STOCK_IN' });
    return result;
  },

  async stockOut(input: {
    productId: string; warehouseId: string; quantity: number; remarks?: string;
    vendorId?: string; txnDate?: string;
  }, actor: Actor): Promise<MovementResult> {
    await ensureNonImeiProduct(input.productId);
    const result = await prisma.$transaction((tx) =>
      applyLedgerMovementTx(tx, {
        productId: input.productId,
        warehouseId: input.warehouseId,
        type: TransactionType.STOCK_OUT,
        signedQty: toSigned(TransactionType.STOCK_OUT, input.quantity),
        remarks: input.remarks ?? null,
        vendorId: input.vendorId ?? null,
        occurredAt: parseTxnDate(input.txnDate),
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

    // Fetch brand-level IMEI/SrNo requirements
    const brandRecord = product.brand
      ? await prisma.brand.findFirst({ where: { name: product.brand, isDeleted: false }, select: { imeiRequired: true, srnoRequired: true } })
      : null;

    // Effective requirement = product setting OR brand setting
    const imeiRequired = product.imeiRequired || (brandRecord?.imeiRequired ?? false);
    const srnoRequired = brandRecord?.srnoRequired ?? false;

    return {
      product: {
        id: product.id, ean: product.ean, sku: product.sku,
        model: product.model, brand: product.brand,
        imeiRequired,      // effective: product OR brand level
        srnoRequired,      // brand level
        brandImeiRequired: brandRecord?.imeiRequired ?? false,
        brandSrnoRequired: brandRecord?.srnoRequired ?? false,
      },
      total: levels.reduce((sum, l) => sum + l.quantity, 0),
      byWarehouse: levels.map((l) => ({
        productId: product.id, warehouseId: l.warehouseId,
        warehouseName: l.warehouse.name, quantity: l.quantity,
      })),
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// SESSION-BASED SCANNING
// Each session = one SIN/SOUT document. Lines are added via scan, then committed.
// ─────────────────────────────────────────────────────────────────────────────

function genDocNumber(prefix: 'SIN' | 'SOUT'): string {
  const d = new Date();
  const ymd = d.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.floor(Math.random() * 9000) + 1000;
  return `${prefix}-${ymd}-${rand}`;
}

// In-memory session store (sufficient for single-server Render free tier)
// Survives within a single request cycle; persist to DB on commit.
const SESSIONS = new Map<string, {
  id: string;
  docNumber: string;
  type: 'STOCK_IN' | 'STOCK_OUT';
  warehouseId: string;
  vendorId?: string;
  remarks?: string;
  createdBy: string;
  createdAt: string;
  lines: { productId: string; ean: string; model: string; imeis: string[]; qty: number; unitCost?: number }[];
  status: 'OPEN' | 'COMMITTED' | 'CANCELLED';
}>();

const inventoryServiceExtensions = {
  async createSession(input: { type: 'STOCK_IN' | 'STOCK_OUT'; warehouseId: string; vendorId?: string; remarks?: string }, actor: { id: string; ip: string | null }) {
    // validate warehouse
    const wh = await prisma.warehouse.findFirst({ where: { id: input.warehouseId, isDeleted: false } });
    if (!wh) throw new BadRequestError('Warehouse not found');
    const id = `ses_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const prefix = input.type === 'STOCK_IN' ? 'SIN' : 'SOUT';
    const session = {
      id, docNumber: genDocNumber(prefix),
      type: input.type, warehouseId: input.warehouseId,
      vendorId: input.vendorId, remarks: input.remarks,
      createdBy: actor.id, createdAt: new Date().toISOString(),
      lines: [], status: 'OPEN' as const,
    };
    SESSIONS.set(id, session);
    return session;
  },

  listSessions({ limit = 30, type }: { limit?: number; type?: string }) {
    const all = [...SESSIONS.values()];
    const filtered = type ? all.filter(s => s.type === type) : all;
    return filtered.slice(-limit).reverse();
  },

  getSession(id: string) {
    const s = SESSIONS.get(id);
    if (!s) throw new BadRequestError('Session not found or expired');
    return s;
  },

  async addSessionLine(sessionId: string, input: { ean?: string; productId?: string; imei?: string; qty?: number; unitCost?: number }, actor: { id: string; ip: string | null }) {
    const session = SESSIONS.get(sessionId);
    if (!session || session.status !== 'OPEN') throw new BadRequestError('Session is not open');

    // Lookup product by EAN or productId
    const product = await prisma.product.findFirst({
      where: {
        ...(input.productId ? { id: input.productId } : { ean: input.ean }),
        isDeleted: false,
      },
    });
    if (!product) return { found: false, ean: input.ean };

    if (product.imeiRequired && input.imei) {
      // IMEI scan — check for duplicate
      const existing = await prisma.imeiInventory.findFirst({ where: { imei: input.imei, isDeleted: false } });
      if (existing && session.type === 'STOCK_IN') {
        // Return duplicate details for popup
        const lastTxn = await prisma.inventoryTransaction.findFirst({
          where: { productId: existing.productId },
          include: { vendor: { select: { name: true } } },
          orderBy: { createdAt: 'desc' },
        });
        return {
          duplicate: true,
          imei: input.imei,
          productId: existing.productId,
          status: existing.status,
          lastVendor: lastTxn?.vendor?.name ?? null,
          lastDate: lastTxn?.createdAt?.toISOString() ?? null,
        };
      }

      let line = session.lines.find(l => l.productId === product.id);
      if (!line) {
        line = { productId: product.id, ean: product.ean, model: product.model, imeis: [], qty: 0, unitCost: input.unitCost };
        session.lines.push(line);
      }
      if (!line.imeis.includes(input.imei)) {
        line.imeis.push(input.imei);
        line.qty = line.imeis.length;
      }
    } else {
      // Non-IMEI: just set/increment quantity
      const qty = Math.max(1, Number(input.qty) || 1);
      let line = session.lines.find(l => l.productId === product.id);
      if (!line) {
        line = { productId: product.id, ean: product.ean, model: product.model, imeis: [], qty: 0, unitCost: input.unitCost };
        session.lines.push(line);
      }
      line.qty += qty;
      if (input.unitCost) line.unitCost = input.unitCost;
    }

    return { found: true, product: { id: product.id, ean: product.ean, model: product.model, imeiRequired: product.imeiRequired }, session };
  },

  async commitSession(sessionId: string, actor: { id: string; ip: string | null }) {
    const session = SESSIONS.get(sessionId);
    if (!session || session.status !== 'OPEN') throw new BadRequestError('Session not open');
    if (!session.lines.length) throw new BadRequestError('No lines to commit');

    const txType: TransactionType = session.type === 'STOCK_IN' ? TransactionType.STOCK_IN : TransactionType.STOCK_OUT;
    const results = [];

    for (const line of session.lines) {
      const signedQty = session.type === 'STOCK_IN' ? line.qty : -line.qty;
      const result = await prisma.$transaction(async (tx) => {
        const r = await applyLedgerMovementTx(tx, {
          productId: line.productId, warehouseId: session.warehouseId,
          type: txType, signedQty,
          unitCost: line.unitCost ?? null,
          vendorId: session.vendorId ?? null,
          referenceType: 'session', referenceId: session.id,
          remarks: session.docNumber,
        }, actor);

        // Handle IMEIs
        if (line.imeis.length) {
          for (const imei of line.imeis) {
            if (session.type === 'STOCK_IN') {
              await tx.imeiInventory.upsert({
                where: { imei },
                create: { imei, productId: line.productId, warehouseId: session.warehouseId, status: 'IN_STOCK', createdBy: actor.id },
                update: { status: 'IN_STOCK', warehouseId: session.warehouseId, updatedBy: actor.id, isDeleted: false, deletedAt: null },
              });
            } else {
              await tx.imeiInventory.updateMany({ where: { imei }, data: { status: 'SOLD', updatedBy: actor.id } });
            }
          }
        }
        return r;
      });
      results.push({ ...line, ...result });
    }

    session.status = 'COMMITTED';
    return { docNumber: session.docNumber, lines: results, total: results.length };
  },

  cancelSession(sessionId: string, _actor: { id: string; ip: string | null }) {
    const session = SESSIONS.get(sessionId);
    if (!session) throw new BadRequestError('Session not found');
    session.status = 'CANCELLED';
    return { cancelled: true, docNumber: session.docNumber };
  },

  async dailySummary(dateStr: string) {
    const from = new Date(dateStr + 'T00:00:00.000Z');
    const to   = new Date(dateStr + 'T23:59:59.999Z');
    const txns = await prisma.inventoryTransaction.findMany({
      where: { createdAt: { gte: from, lte: to } },
      include: {
        product: { select: { ean: true, model: true, brand: true, categoryId: true } },
        vendor:  { select: { name: true } },
        warehouse: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const stockIn  = txns.filter(t => t.quantity > 0);
    const stockOut = txns.filter(t => t.quantity < 0);

    const byProduct = new Map<string, { ean: string; model: string; brand: string; inQty: number; outQty: number; vendors: Set<string> }>();
    for (const t of txns) {
      const key = t.productId;
      if (!byProduct.has(key)) byProduct.set(key, { ean: t.product.ean, model: t.product.model, brand: t.product.brand, inQty: 0, outQty: 0, vendors: new Set() });
      const row = byProduct.get(key)!;
      if (t.quantity > 0) row.inQty += t.quantity;
      else row.outQty += Math.abs(t.quantity);
      if (t.vendor) row.vendors.add(t.vendor.name);
    }

    const imeiIn  = await prisma.imeiInventory.count({ where: { createdAt: { gte: from, lte: to }, status: 'IN_STOCK' } });
    const imeiOut = await prisma.imeiInventory.count({ where: { updatedAt: { gte: from, lte: to }, status: 'SOLD' } });

    return {
      date: dateStr,
      totals: {
        stockInTxns: stockIn.length,
        stockOutTxns: stockOut.length,
        stockInUnits: stockIn.reduce((s, t) => s + t.quantity, 0),
        stockOutUnits: stockOut.reduce((s, t) => s + Math.abs(t.quantity), 0),
        imeiIn, imeiOut,
      },
      byProduct: [...byProduct.entries()].map(([id, v]) => ({
        productId: id, ...v, vendors: [...v.vendors],
      })),
      // No slice here: the dashboard groups these by supplier and product, so
      // truncating hides transactions and makes the totals disagree with the
      // list (a 120-unit day was only showing the first 50 rows).
      recentTxns: txns.map(t => ({
        id: t.id, type: t.type, qty: t.quantity,
        product: t.product.model,
        productId: t.productId,
        ean: t.product.ean,
        vendor: t.vendor?.name,
        vendorId: t.vendorId,
        warehouse: t.warehouse.name,
        warehouseId: t.warehouseId,
        createdAt: t.createdAt.toISOString(),
      })),
    };
  },

  async dashboardStats() {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [products, activeProducts, vendors, categories, brands, todayIn, todayOut, imeiToday] = await Promise.all([
      prisma.product.count({ where: { isDeleted: false } }),
      prisma.product.count({ where: { isDeleted: false, status: 'ACTIVE' } }),
      prisma.vendor.count({ where: { isDeleted: false } }),
      prisma.productCategory.count({ where: { isDeleted: false } }),
      prisma.brand.count({ where: { isDeleted: false } }),
      prisma.inventoryTransaction.aggregate({ where: { type: TransactionType.STOCK_IN, createdAt: { gte: todayStart } }, _sum: { quantity: true } }),
      prisma.inventoryTransaction.aggregate({ where: { type: TransactionType.STOCK_OUT, createdAt: { gte: todayStart } }, _sum: { quantity: true } }),
      prisma.imeiInventory.count({ where: { createdAt: { gte: todayStart } } }),
    ]);

    return {
      products, activeProducts, vendors, categories, brands,
      today: {
        stockIn:  todayIn._sum.quantity  ?? 0,
        stockOut: todayOut._sum.quantity ?? 0,
        imeiScanned: imeiToday,
      },
    };
  },
};

// Merge into the existing inventoryService export
Object.assign(inventoryService, inventoryServiceExtensions);

// ── Fully delete a stock transaction (dashboard "delete as if never happened") ─
// 1. Directly adjusts StockLevel (no new transaction created)
// 2. Removes IMEI records from that time window
// 3. Hard-deletes the transaction record
// 4. Writes to Version History (audit)
Object.assign(inventoryService, {
  async reverseTransaction(txnId: string, actor: { id: string; ip: string | null }) {
    const txn = await prisma.inventoryTransaction.findUnique({
      where: { id: txnId },
      include: { product: { select: { id: true, model: true, imeiRequired: true } }, vendor: { select: { name: true } } },
    });
    if (!txn) throw new BadRequestError('Transaction not found');

    await prisma.$transaction(async (tx) => {
      // 1. Undo stock level — clamp to 0 to avoid CHECK(quantity>=0) violation
      const sl = await tx.stockLevel.findFirst({
        where: { productId: txn.productId, warehouseId: txn.warehouseId },
      });
      if (sl) {
        await tx.stockLevel.update({
          where: { id: sl.id },
          data: { quantity: Math.max(0, sl.quantity - txn.quantity) },
        });
      }

      // 2. Soft-delete ALL IMEI records linked to this transaction.
      // Do NOT gate on product.imeiRequired — it may be false even for phones
      // (data issue in Product Master). Always attempt deletion; no-op if none exist.
      if (txn.quantity > 0) {
        // PRIMARY: exact match via stockInTxnId (set since the fix was deployed)
        const byTxnId = await tx.imeiInventory.updateMany({
          where: { stockInTxnId: txnId, isDeleted: false },
          data: { isDeleted: true, deletedAt: new Date(), deletedBy: actor.id },
        });
        // LEGACY FALLBACK for rows created before stockInTxnId existed.
        // Scoped deliberately: an unscoped delete here would wipe every
        // in-stock unit of the product, including ones from other entries,
        // taking their swipe/activation history with it. Limit to this
        // transaction's own quantity, oldest first, so only the units this
        // entry actually brought in are removed.
        if (byTxnId.count === 0) {
          const legacy = await tx.imeiInventory.findMany({
            where: {
              productId: txn.productId,
              warehouseId: txn.warehouseId,
              isDeleted: false,
              stockInTxnId: null,
            },
            select: { id: true },
            orderBy: { createdAt: 'asc' },
            take: txn.quantity,
          });
          if (legacy.length) {
            await tx.imeiInventory.updateMany({
              where: { id: { in: legacy.map(l => l.id) } },
              data: { isDeleted: true, deletedAt: new Date(), deletedBy: actor.id },
            });
          }
        }
      }

      // 3. Write audit log with FULL data (needed for restore)
      await writeAudit(tx, {
        userId: actor.id, action: 'DELETE',
        entityName: 'inventory_transactions', entityId: txnId,
        oldValue: {
          productId: txn.productId, warehouseId: txn.warehouseId,
          type: txn.type, quantity: txn.quantity,
          vendorId: txn.vendorId ?? null, remarks: txn.remarks ?? null,
          createdAt: txn.createdAt.toISOString(),
          product: txn.product.model, vendor: txn.vendor?.name ?? null,
          imeiRequired: txn.product.imeiRequired,
        },
        newValue: { fullyDeleted: true, reason: 'Deleted by admin — scan error' },
        ipAddress: actor.ip,
      });

      // FK safety: null out stockInTxnId before hard-delete
      await tx.imeiInventory.updateMany({
        where: { stockInTxnId: txnId },
        data: { stockInTxnId: null },
      });
      await tx.inventoryTransaction.delete({ where: { id: txnId } });
    }, { timeout: 15000, maxWait: 10000 });

    return { deleted: true, txnId, productId: txn.productId };
  },

  // ── Bulk-delete a supplier's full batch (one grouped audit entry) ──────────
  // Called when user clicks "Delete" on a vendor card in Dashboard.
  // Deletes all transactions in one DB transaction and writes a SINGLE
  // Version History entry showing the whole batch — not one entry per product.
  async bulkReverseTransactions(txnIds: string[], actor: { id: string; ip: string | null }) {
    if (!txnIds.length) return { deleted: 0 };

    const txns = await prisma.inventoryTransaction.findMany({
      where: { id: { in: txnIds } },
      include: { product: { select: { id: true, model: true, imeiRequired: true } }, vendor: { select: { name: true } } },
    });
    if (!txns.length) throw new BadRequestError('No transactions found');

    const vendorName = txns[0].vendor?.name ?? 'Unknown Supplier';
    const totalQty = txns.reduce((s, t) => s + Math.abs(t.quantity), 0);

    // Build a summary of what was deleted (for Version History display)
    const productSummary: Record<string, number> = {};
    for (const t of txns) {
      const m = t.product.model;
      productSummary[m] = (productSummary[m] || 0) + Math.abs(t.quantity);
    }

    // ── Batch everything instead of looping per-transaction ──────────────────
    // The old code ran 4+ sequential queries PER transaction inside one DB
    // transaction (16 items = 64+ queries), which exceeded Prisma's default
    // 5s interactive-transaction timeout on Supabase's pooler — causing
    // "Internal server error" specifically on larger batches (e.g. a 16-item
    // "No Vendor" entry) while smaller single-vendor batches happened to
    // finish in time. Fix: aggregate stock deltas and use IN-clause bulk
    // operations so the whole batch is a handful of queries, not dozens.

    // 1. Aggregate stock quantity to subtract, per productId+warehouseId
    const deltaByKey = new Map<string, { productId: string; warehouseId: string; qty: number }>();
    for (const t of txns) {
      const key = `${t.productId}::${t.warehouseId}`;
      const cur = deltaByKey.get(key) ?? { productId: t.productId, warehouseId: t.warehouseId, qty: 0 };
      cur.qty += t.quantity;
      deltaByKey.set(key, cur);
    }

    await prisma.$transaction(async (tx) => {
      // 2. Apply stock level adjustments — one query per unique product+warehouse
      //    (typically far fewer than txnIds.length since products repeat)
      for (const { productId, warehouseId, qty } of deltaByKey.values()) {
        const sl = await tx.stockLevel.findFirst({ where: { productId, warehouseId } });
        if (sl) {
          await tx.stockLevel.update({
            where: { id: sl.id },
            data: { quantity: Math.max(0, sl.quantity - qty) },
          });
        }
      }

      // 3. Soft-delete ALL linked IMEI records in ONE bulk query
      const byTxnId = await tx.imeiInventory.updateMany({
        where: { stockInTxnId: { in: txnIds }, isDeleted: false },
        data: { isDeleted: true, deletedAt: new Date(), deletedBy: actor.id },
      });

      // 4. LEGACY FALLBACK: for any product+warehouse pair where no IMEI matched
      //    by stockInTxnId (old records missing the link), soft-delete by
      //    product+warehouse instead — batched per unique pair, not per txn.
      if (byTxnId.count === 0) {
        for (const { productId, warehouseId } of deltaByKey.values()) {
          await tx.imeiInventory.updateMany({
            where: { productId, warehouseId, isDeleted: false },
            data: { isDeleted: true, deletedAt: new Date(), deletedBy: actor.id },
          });
        }
      }

      // 5. FK safety: null out stockInTxnId for the whole batch in ONE query
      await tx.imeiInventory.updateMany({
        where: { stockInTxnId: { in: txnIds } },
        data: { stockInTxnId: null },
      });

      // 6. Hard-delete all transactions in ONE query
      await tx.inventoryTransaction.deleteMany({ where: { id: { in: txnIds } } });

      // 7. Write ONE grouped audit entry for the whole batch
      await writeAudit(tx, {
        userId: actor.id, action: 'DELETE',
        entityName: 'inventory_transactions',
        entityId: txnIds[0], // anchor on first txn id
        oldValue: {
          bulk: true,
          txnIds,
          vendor: vendorName,
          totalQty,
          products: productSummary,
          deletedAt: new Date().toISOString(),
        },
        newValue: { fullyDeleted: true, txnCount: txnIds.length, reason: `Bulk deleted — ${vendorName} entry` },
        ipAddress: actor.ip,
      });
    }, { timeout: 30000, maxWait: 10000 }); // generous timeout as a safety net for large batches

    return { deleted: txnIds.length, vendor: vendorName, totalQty };
  },
});

