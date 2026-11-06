/**
 * Matching scanned codes to stored units, regardless of letter case.
 *
 * Serial numbers are written down and scanned with caps lock on or off, and
 * the stored value is whatever case it was first saved in. Comparing them
 * exactly meant a serial saved in capitals could not be found again with caps
 * lock off, so the unit could not be dispatched even though it was plainly the
 * same serial. IMEIs are digits and unaffected either way.
 */
export const normCode = (s: string) => s.trim().toLowerCase();

export interface UnitCodes { imei1: string; serialNo: string | null }

/**
 * Map each scanned code to the stored unit's own IMEI/serial value (imei1),
 * ignoring case and surrounding spaces. A code can match a unit's imei1 or its
 * serialNo. Codes that match nothing are returned as typed so the caller can
 * report them as not found, and codes that turn out to be the same unit (the
 * same serial scanned in two different cases) collapse to one.
 */
export function resolveScanned(scanned: string[], units: UnitCodes[]): string[] {
  const byImei = new Map<string, string>();
  const bySerial = new Map<string, string>();
  for (const u of units) {
    byImei.set(normCode(u.imei1), u.imei1);
    if (u.serialNo) bySerial.set(normCode(u.serialNo), u.imei1);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of scanned) {
    const code = raw.trim();
    const hit = byImei.get(normCode(code)) ?? bySerial.get(normCode(code)) ?? code;
    const key = normCode(hit);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}
