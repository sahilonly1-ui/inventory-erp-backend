/*
 * Market Prices groups products by model + variant: colours are dropped, so
 * "Ai+ Nova 2 Pro 5G 8/128GB (Black)" and "(Blue)" become one entry
 * "Ai+ Nova 2 Pro 5G 8/128GB". Stores sell every colour of a variant at the
 * same price, so one fetch covers them all.
 */
const clean = (s: string) => String(s ?? '').replace(/[ ​-‍﻿]/g, ' ').replace(/\s+/g, ' ').trim();

/** Display name without colour: brackets keep only the parts with a digit (RAM / storage / model code). */
export function variantName(model: string): string {
  let m = clean(model)
    // Apple part numbers differ per colour (MQD83HN/A, MPUF3HN/A): drop them.
    .replace(/\b[A-Z0-9]{4,6}[A-Z]{1,2}\/A\b/g, ' ');
  m = m.replace(/\(([^()]*)\)/g, (_all, inner: string) => {
    const keep = inner.split(/[,|]/).map(x => x.trim()).filter(x => /\d/.test(x));
    return keep.length ? `(${keep.join(', ')})` : ' ';
  });
  return clean(m.replace(/\(\s*\)/g, ' ').replace(/\s+,/g, ','));
}

/** Grouping key: brand + colour-free name, case/spacing-insensitive. */
export function variantKey(brand: string | null | undefined, model: string): string {
  return `${clean(brand ?? '').toLowerCase()}|${variantName(model).toLowerCase().replace(/[^a-z0-9+/.]+/g, ' ').trim()}`;
}
