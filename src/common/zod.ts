import { z } from 'zod';

// Strict boolean parser. Unlike z.coerce.boolean() (which is Boolean(v), so
// "false" -> true), this maps real true/false strings correctly and rejects
// anything ambiguous.
export const booleanish = z.preprocess((v) => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true', '1', 'yes', 'y'].includes(s)) return true;
    if (['false', '0', 'no', 'n', ''].includes(s)) return false;
  }
  return v;
}, z.boolean());
