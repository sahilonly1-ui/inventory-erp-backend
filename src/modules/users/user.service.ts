import { prisma } from '../../config/prisma';
import { ConflictError, NotFoundError } from '../../common/errors';
import { writeAudit } from '../../common/audit.service';
import { hashPassword } from '../../utils/password.util';
import { userRepository } from './user.repository';
import { PaginatedUsers } from './user.dto';
import { CreateUserInput, UpdateUserInput, ListUsersInput } from './user.validator';

const toListItem = (u: { id: string; email: string; fullName: string; isActive: boolean; createdAt: Date; roles: { name: string }[] }) => ({
  id: u.id,
  email: u.email,
  fullName: u.fullName,
  isActive: u.isActive,
  roles: u.roles.map((r) => r.name),
  createdAt: u.createdAt,
});

export const userService = {
  async create(input: CreateUserInput, actorId: string, ip: string | null) {
    const exists = await prisma.user.findFirst({ where: { email: input.email, isDeleted: false } });
    if (exists) throw new ConflictError('Email already in use');

    const passwordHash = await hashPassword(input.password);

    return prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: input.email,
          passwordHash,
          fullName: input.fullName,
          createdBy: actorId,
          roles: input.roleIds.length ? { connect: input.roleIds.map((id) => ({ id })) } : undefined,
        },
        include: { roles: true },
      });
      await writeAudit(tx, {
        userId: actorId,
        action: 'CREATE',
        entityName: 'users',
        entityId: user.id,
        newValue: { email: user.email, fullName: user.fullName, roleIds: input.roleIds },
        ipAddress: ip,
      });
      return toListItem(user);
    });
  },

  async list(input: ListUsersInput): Promise<PaginatedUsers> {
    const [items, total] = await userRepository.list({
      skip: (input.page - 1) * input.limit,
      take: input.limit,
      search: input.search,
    });
    return {
      items: items.map(toListItem),
      page: input.page,
      limit: input.limit,
      total,
      totalPages: Math.ceil(total / input.limit),
    };
  },

  async getById(id: string) {
    const user = await userRepository.findById(id);
    if (!user) throw new NotFoundError('User not found');
    return toListItem(user);
  },

  async update(id: string, input: UpdateUserInput, actorId: string, ip: string | null) {
    const existing = await userRepository.findById(id);
    if (!existing) throw new NotFoundError('User not found');

    return prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id },
        data: { ...input, updatedBy: actorId },
        include: { roles: true },
      });
      await writeAudit(tx, {
        userId: actorId,
        action: 'UPDATE',
        entityName: 'users',
        entityId: id,
        oldValue: { fullName: existing.fullName, isActive: existing.isActive },
        newValue: input,
        ipAddress: ip,
      });
      // Deactivation must also kill live sessions.
      if (input.isActive === false) {
        await tx.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      }
      return toListItem(updated);
    });
  },

  async assignRoles(id: string, roleIds: string[], actorId: string, ip: string | null) {
    const existing = await userRepository.findById(id);
    if (!existing) throw new NotFoundError('User not found');

    return prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id },
        data: { roles: { set: roleIds.map((rid) => ({ id: rid })) }, updatedBy: actorId },
        include: { roles: true },
      });
      await writeAudit(tx, {
        userId: actorId,
        action: 'UPDATE',
        entityName: 'users',
        entityId: id,
        newValue: { roleIds },
        ipAddress: ip,
      });
      return toListItem(updated);
    });
  },

  async softDelete(id: string, actorId: string, ip: string | null) {
    const existing = await userRepository.findById(id);
    if (!existing) throw new NotFoundError('User not found');

    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id },
        data: { isDeleted: true, deletedAt: new Date(), deletedBy: actorId, isActive: false },
      });
      await tx.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      await writeAudit(tx, {
        userId: actorId,
        action: 'DELETE',
        entityName: 'users',
        entityId: id,
        ipAddress: ip,
      });
    });
  },

  async restore(id: string, actorId: string, ip: string | null) {
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user || !user.isDeleted) throw new NotFoundError('Deleted user not found');

    return prisma.$transaction(async (tx) => {
      const restored = await tx.user.update({
        where: { id },
        data: { isDeleted: false, deletedAt: null, deletedBy: null, isActive: true, updatedBy: actorId },
        include: { roles: true },
      });
      await writeAudit(tx, {
        userId: actorId,
        action: 'RESTORE',
        entityName: 'users',
        entityId: id,
        ipAddress: ip,
      });
      return toListItem(restored);
    });
  },
};
