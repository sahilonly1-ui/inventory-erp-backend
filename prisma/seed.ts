import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { ALL_PERMISSIONS, WILDCARD } from '../src/constants/permissions';

const prisma = new PrismaClient();

async function main() {
  // 1. Permissions (catalog + wildcard)
  for (const code of [...ALL_PERMISSIONS, WILDCARD]) {
    await prisma.permission.upsert({ where: { code }, update: {}, create: { code } });
  }
  const wildcard = await prisma.permission.findUniqueOrThrow({ where: { code: WILDCARD } });

  // 2. ADMIN role gets the wildcard
  const admin = await prisma.role.upsert({
    where: { name: 'ADMIN' },
    update: {},
    create: { name: 'ADMIN', description: 'Full system access' },
  });
  await prisma.role.update({
    where: { id: admin.id },
    data: { permissions: { connect: { id: wildcard.id } } },
  });

  // 3. STAFF role with a read-only baseline
  await prisma.role.upsert({
    where: { name: 'STAFF' },
    update: {},
    create: {
      name: 'STAFF',
      description: 'Operational staff',
      permissions: {
        connect: [
          { code: 'products.read' }, { code: 'vendors.read' }, { code: 'warehouses.read' },
          { code: 'inventory.read' }, { code: 'imei.read' }, { code: 'marketplace.read' },
        ],
      },
    },
  });

  // 4. Bootstrap admin user (email is partial-unique, so use findFirst not upsert)
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (email && password) {
    const existing = await prisma.user.findFirst({ where: { email, isDeleted: false } });
    if (!existing) {
      const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
      await prisma.user.create({
        data: {
          email,
          passwordHash,
          fullName: 'Administrator',
          roles: { connect: { id: admin.id } },
        },
      });
      console.log(`Seeded admin user: ${email}`);
    } else {
      console.log('Admin user already exists, skipping');
    }
  } else {
    console.log('BOOTSTRAP_ADMIN_* not set, skipping admin user');
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
