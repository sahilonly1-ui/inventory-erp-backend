/** Run: npx ts-node --transpile-only src/__tests__/categoryMerge.test.ts */
import { pickKeeper, CategoryLite } from '../modules/products/category.merge';

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}`);
  if (!ok) console.log(`        expected ${expected}, got ${actual}`);
}

const cat = (id: string, name: string, day: string): CategoryLite => ({ id, name, createdAt: new Date(`${day}T00:00:00Z`) });
const counts = (o: Record<string, number>) => new Map(Object.entries(o));

console.log('\nChoosing the surviving category:\n');

check('a category already named like the target is kept, even with fewer products',
  pickKeeper([cat('plural', 'Smartphones', '2026-01-01'), cat('single', 'Smartphone', '2026-02-01')],
             counts({ plural: 900, single: 12 }), 'Smartphone').id, 'single');

check('name match ignores case and surrounding spaces',
  pickKeeper([cat('a', 'Smartphones', '2026-01-01'), cat('b', '  smartphone ', '2026-02-01')],
             counts({ a: 5, b: 1 }), 'Smartphone').id, 'b');

check('with no exact match, the one holding the most products survives',
  pickKeeper([cat('a', 'Phones', '2026-01-01'), cat('b', 'Mobiles', '2026-02-01')],
             counts({ a: 3, b: 40 }), 'Smartphone').id, 'b');

check('among several exact matches, the one with the most products survives',
  pickKeeper([cat('a', 'Smartphone', '2026-01-01'), cat('b', 'smartphone', '2026-02-01')],
             counts({ a: 2, b: 30 }), 'Smartphone').id, 'b');

check('a tie goes to the oldest',
  pickKeeper([cat('new', 'Smartphone', '2026-06-01'), cat('old', 'Smartphone', '2026-01-01')],
             counts({ new: 4, old: 4 }), 'Smartphone').id, 'old');

check('a category with no entry in the counts is treated as empty',
  pickKeeper([cat('a', 'Smartphones', '2026-01-01'), cat('b', 'Smartphones', '2026-02-01')],
             counts({ b: 1 }), 'Smartphone').id, 'b');

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'}\n`);
process.exit(failures === 0 ? 0 : 1);
