import { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { ConflictError, NotFoundError } from '../../common/errors';
import { writeAudit } from '../../common/audit.service';

interface Actor { id: string; ip: string | null; }

// ── Name helpers ─────────────────────────────────────────────────────────────
// Title-case: "nalanda enterprises" → "Nalanda Enterprises"
export function toTitleCase(name: string): string {
  return name.trim().replace(/\b\w+/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}
// Normalize for dedup: trim, lowercase, remove all whitespace
export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '');
}

export const vendorService = {
  // Standard CRUD ─────────────────────────────────────────────────────────────
  async create(input: any, actor: Actor) {
    const displayName = toTitleCase(input.name || '');
    const norm = normalizeName(displayName);
    const dup = await prisma.vendor.findFirst({ where: { normalizedName: norm, isDeleted: false } });
    if (dup) throw new ConflictError(`Supplier "${displayName}" already exists`);
    // Generate a code that won't conflict (no longer user-visible)
    const code = norm.slice(0, 10).toUpperCase() + Date.now().toString().slice(-6);
    return prisma.$transaction(async (tx) => {
      const vendor = await tx.vendor.create({ data: { ...input, name: displayName, code, normalizedName: norm, createdBy: actor.id } });
      await writeAudit(tx, { userId: actor.id, action: 'CREATE', entityName: 'vendors', entityId: vendor.id, newValue: { name: vendor.name, state: (vendor as any).state }, ipAddress: actor.ip });
      return vendor;
    });
  },

  list() {
    return prisma.vendor.findMany({ where: { isDeleted: false }, orderBy: { name: 'asc' } });
  },

  async get(id: string) {
    const v = await prisma.vendor.findFirst({ where: { id, isDeleted: false } });
    if (!v) throw new NotFoundError('Supplier not found');
    return v;
  },

  async update(id: string, input: any, actor: Actor) {
    const existing = await prisma.vendor.findFirst({ where: { id, isDeleted: false } });
    if (!existing) throw new NotFoundError('Supplier not found');
    const patch: any = { ...input, updatedBy: actor.id };
    if (input.name) { patch.name = toTitleCase(input.name); patch.normalizedName = normalizeName(patch.name); }
    return prisma.$transaction(async (tx) => {
      const vendor = await tx.vendor.update({ where: { id }, data: patch });
      await writeAudit(tx, { userId: actor.id, action: 'UPDATE', entityName: 'vendors', entityId: id, oldValue: { name: existing.name }, newValue: patch, ipAddress: actor.ip });
      return vendor;
    });
  },

  async remove(id: string, actor: Actor) {
    const existing = await prisma.vendor.findFirst({ where: { id, isDeleted: false } });
    if (!existing) throw new NotFoundError('Supplier not found');
    await prisma.$transaction(async (tx) => {
      await tx.vendor.update({ where: { id }, data: { isDeleted: true, deletedAt: new Date(), deletedBy: actor.id } });
      await writeAudit(tx, { userId: actor.id, action: 'DELETE', entityName: 'vendors', entityId: id, ipAddress: actor.ip });
    });
  },

  // ── Smart find-or-create (used by Stock In/Out) ───────────────────────────
  // Returns { vendor, created: boolean, needsState: boolean }
  /**
   * Find a counterparty by name, creating it when it doesn't exist.
   *
   * `allowWithoutState` exists for the customer side of Stock Out. A supplier
   * needs a state for GST purposes and Stock In prompts for one, but asking a
   * shop assistant for the home state of a walk-in customer is meaningless —
   * and refusing to create the record meant every named customer silently
   * saved as "No Vendor".
   */
  async findOrCreate(name: string, state: string | undefined, actor: Actor, allowWithoutState = false) {
    const displayName = toTitleCase(name);
    const norm = normalizeName(displayName);

    const existing = await prisma.vendor.findFirst({ where: { normalizedName: norm, isDeleted: false } });
    if (existing) return { vendor: existing, created: false, needsState: false };

    if (!state && !allowWithoutState) {
      return { vendor: null, created: false, needsState: true, suggestedName: displayName };
    }

    const code = norm.slice(0, 10).toUpperCase() + Date.now().toString().slice(-6);
    const vendor = await prisma.$transaction(async (tx) => {
      const v = await tx.vendor.create({
        data: { name: displayName, code, normalizedName: norm, state: state ?? null, createdBy: actor.id },
      });
      await writeAudit(tx, { userId: actor.id, action: 'CREATE', entityName: 'vendors', entityId: v.id, newValue: { name: v.name, state: state ?? null, autoCreated: true }, ipAddress: actor.ip });
      return v;
    });
    return { vendor, created: true, needsState: false };
  },

  // ── Bulk clear (preserves historical references) ──────────────────────────
  async clearAll(actor: Actor) {
    const all = await prisma.vendor.findMany({ where: { isDeleted: false }, select: { id: true, name: true } });
    if (!all.length) return { deleted: 0 };
    const now = new Date();
    await prisma.vendor.updateMany({
      where: { isDeleted: false },
      data: { isDeleted: true, deletedAt: now, deletedBy: actor.id },
    });
    await writeAudit(prisma, { userId: actor.id, action: 'DELETE', entityName: 'vendors', entityId: 'BULK', newValue: { count: all.length, note: 'Supplier Master reset' }, ipAddress: actor.ip });
    return { deleted: all.length };
  },

  // ── Autocomplete search ────────────────────────────────────────────────────
  async search(q: string, limit = 15) {
    if (!q.trim()) return prisma.vendor.findMany({ where: { isDeleted: false }, orderBy: { name: 'asc' }, take: limit });
    const words = q.trim().split(/\s+/).filter(Boolean);
    const where: any = words.length <= 1
      ? { isDeleted: false, name: { contains: q.trim(), mode: 'insensitive' } }
      : { isDeleted: false, AND: words.map((w: string) => ({ name: { contains: w, mode: 'insensitive' } })) };
    return prisma.vendor.findMany({
      where,
      orderBy: { name: 'asc' }, take: limit,
    });
  },

  async vendorStock(vendorId: string) {
    const products = await prisma.product.findMany({ where: { vendorId, isDeleted: false }, select: { id: true, ean: true, sku: true, model: true, stockLevels: { select: { warehouseId: true, quantity: true } } } });
    const rows = products.map(p => { const quantity = p.stockLevels.reduce((s, l) => s + l.quantity, 0); return { productId: p.id, ean: p.ean, sku: p.sku, model: p.model, quantity }; });
    return { vendorId, totalUnits: rows.reduce((s, r) => s + r.quantity, 0), products: rows };
  },
};
