import { z } from 'zod';

export const createUserSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(8).max(128),
  fullName: z.string().min(2).max(120),
  roleIds: z.array(z.string().uuid()).default([]),
});

export const updateUserSchema = z
  .object({
    fullName: z.string().min(2).max(120).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

export const assignRolesSchema = z.object({
  roleIds: z.array(z.string().uuid()).min(1),
});

export const listUsersSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  search: z.string().trim().max(120).optional(),
});

export const idParamSchema = z.object({ id: z.string().uuid() });

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type ListUsersInput = z.infer<typeof listUsersSchema>;
