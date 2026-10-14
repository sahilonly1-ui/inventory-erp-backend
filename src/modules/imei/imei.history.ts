/**
 * Which swipe / activation state a re-created unit should inherit.
 *
 * Editing a Stock In entry, or re-entering a unit, creates a fresh row and
 * soft-deletes the old one, so a unit can accumulate several deleted
 * generations. The state worth keeping may not be on the newest of them: if an
 * earlier edit ever produced a generation without the flags, copying only the
 * newest deleted row would carry that loss forward on every later edit while
 * the real history sat untouched one generation back.
 *
 * Each flag is therefore taken from the most recent generation that actually
 * had it set, independently of the other.
 */
export interface FlagRow {
  swiped: boolean;
  swipedAt: Date | null;
  activated: boolean;
  activatedAt: Date | null;
  updatedAt: Date;
}

export interface CarriedFlags {
  swiped: boolean;
  swipedAt: Date | null;
  activated: boolean;
  activatedAt: Date | null;
}

export function mergeHistory(rows: FlagRow[]): CarriedFlags {
  const newestFirst = [...rows].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  const sw = newestFirst.find(r => r.swiped);
  const ac = newestFirst.find(r => r.activated);
  return {
    swiped: !!sw,
    swipedAt: sw?.swipedAt ?? null,
    activated: !!ac,
    activatedAt: ac?.activatedAt ?? null,
  };
}
