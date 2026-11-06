/**
 * Which of several duplicate categories survives a merge.
 *
 * The survivor is the one products already point at, so the fewest records have
 * to move: an exact match for the chosen name wins first (so a category that is
 * already called what it will end up called is kept as-is), then the one with
 * the most products, then the oldest.
 */
export interface CategoryLite { id: string; name: string; createdAt: Date }

const norm = (s: string) => s.trim().toLowerCase();

export function pickKeeper<T extends CategoryLite>(
  cats: T[],
  productCount: Map<string, number>,
  targetName: string,
): T {
  if (!cats.length) throw new Error('pickKeeper needs at least one category');
  const exact = cats.filter(c => norm(c.name) === norm(targetName));
  const pool = exact.length ? exact : cats;
  return [...pool].sort((a, b) =>
    (productCount.get(b.id) ?? 0) - (productCount.get(a.id) ?? 0) ||
    a.createdAt.getTime() - b.createdAt.getTime(),
  )[0];
}
