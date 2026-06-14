import { Request, Response } from 'express';
import { asyncHandler } from '../../common/asyncHandler';
import { ok } from '../../common/apiResponse';
import { UnauthorizedError } from '../../common/errors';
import { productService } from './product.service';

const actor = (req: Request) => {
  if (!req.user) throw new UnauthorizedError();
  return { id: req.user.id, ip: req.ip ?? null };
};

export const productController = {
  create: asyncHandler(async (req, res) => ok(res, await productService.create(req.body, actor(req)), 201)),
  list: asyncHandler(async (req, res) => ok(res, await productService.list(req.query as never))),
  get: asyncHandler(async (req, res) => ok(res, await productService.get(req.params.id))),
  update: asyncHandler(async (req, res) => ok(res, await productService.update(req.params.id, req.body, actor(req)))),
  remove: asyncHandler(async (req, res) => { await productService.remove(req.params.id, actor(req)); ok(res, { message: 'Product deleted (soft)' }); }),
  restore: asyncHandler(async (req, res) => ok(res, await productService.restore(req.params.id, actor(req)))),
  createCategory: asyncHandler(async (req, res) => ok(res, await productService.createCategory(req.body, actor(req)), 201)),
  listCategories: asyncHandler(async (_req, res) => ok(res, await productService.listCategories())),
};
