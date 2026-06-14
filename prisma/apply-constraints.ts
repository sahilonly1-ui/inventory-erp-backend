import { readFileSync } from 'fs';
import { join } from 'path';
import { prisma } from '../src/config/prisma';

// Applies partial unique indexes + the non-negative-stock CHECK that Prisma's
// DSL cannot express. Idempotent (IF NOT EXISTS / DROP IF EXISTS).
async function main() {
  const sql = readFileSync(join(__dirname, 'manual/0001_constraints.sql'), 'utf8');
  const cleaned = sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
  const statements = cleaned.split(';').map((s) => s.trim()).filter(Boolean);

  for (const stmt of statements) {
    await prisma.$executeRawUnsafe(stmt);
  }
  console.log(`Applied ${statements.length} constraint statement(s)`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
