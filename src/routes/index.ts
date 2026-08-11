import { Router, Request, Response } from 'express';
import { prisma } from '../config/prisma';
import authRoutes from '../modules/auth/auth.routes';
import userRoutes from '../modules/users/user.routes';
import roleRoutes from '../modules/roles/role.routes';
import productRoutes from '../modules/products/product.routes';
import auditRoutes from '../modules/audit/audit.routes';
import warehouseRoutes from '../modules/warehouses/warehouse.module';
import vendorRoutes from '../modules/vendors/vendor.routes';
import inventoryRoutes from '../modules/inventory/inventory.routes';
import imeiRoutes from '../modules/imei/imei.routes';
import marketplaceRoutes from '../modules/marketplace/marketplace.routes';
import reportRoutes from '../modules/reports/report.routes';
import importRoutes from '../modules/imports/import.routes';

const router = Router();

router.get('/health', async (_req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', db: 'up', ts: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'degraded', db: 'down' });
  }
});

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/roles', roleRoutes);
router.use('/products', productRoutes);
router.use('/audit', auditRoutes);
router.use('/warehouses', warehouseRoutes);
router.use('/vendors', vendorRoutes);
router.use('/inventory', inventoryRoutes);
router.use('/imei', imeiRoutes);
router.use('/marketplace', marketplaceRoutes);
router.use('/reports', reportRoutes);
router.use('/imports', importRoutes);

export default router;
