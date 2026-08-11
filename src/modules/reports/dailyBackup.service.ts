import { prisma } from '../../config/prisma';
import { logger } from '../../config/logger';
import { mailer } from '../../common/mailer';
import { buildEntryExport } from './entryExport.service';

// Entries are grouped the same way the dashboard groups them: same vendor,
// same minute. One email per group keeps each invoice separately retrievable
// from the mailbox rather than buried in a combined workbook.
function groupKey(vendorId: string | null, createdAt: Date): string {
  return `${vendorId ?? 'none'}::${createdAt.toISOString().slice(0, 16)}`;
}

export interface DailyBackupResult {
  date: string;
  entries: number;
  sent: number;
  failed: number;
  skipped: boolean;
}

/**
 * Email one workbook per vendor stock-in entry for the given day.
 *
 * Runs unattended, so a single bad entry must not abort the rest — each entry
 * is sent independently and failures are counted, not thrown.
 */
export async function sendDailyStockInBackup(dateStr: string): Promise<DailyBackupResult> {
  const to = process.env.BACKUP_EMAIL_TO;
  const result: DailyBackupResult = { date: dateStr, entries: 0, sent: 0, failed: 0, skipped: false };

  if (!to) {
    logger.warn('BACKUP_EMAIL_TO not set — daily stock-in backup skipped');
    result.skipped = true;
    return result;
  }
  if (!mailer.isConfigured) {
    logger.warn('SMTP not configured — daily stock-in backup skipped');
    result.skipped = true;
    return result;
  }

  const from = new Date(dateStr + 'T00:00:00.000Z');
  const till = new Date(dateStr + 'T23:59:59.999Z');

  const txns = await prisma.inventoryTransaction.findMany({
    where: { createdAt: { gte: from, lte: till }, quantity: { gt: 0 } },
    select: { id: true, vendorId: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  if (!txns.length) {
    logger.info({ date: dateStr }, 'No stock-in entries to back up');
    return result;
  }

  const groups = new Map<string, string[]>();
  for (const t of txns) {
    const k = groupKey(t.vendorId, t.createdAt);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(t.id);
  }
  result.entries = groups.size;

  for (const [key, ids] of groups) {
    try {
      const exp = await buildEntryExport(ids);
      const subject = `Stock In — ${exp.vendorName}${exp.invoiceNo ? ` — Invoice ${exp.invoiceNo}` : ''} — ${exp.dateLabel}`;
      const body =
        `Automated stock-in backup from iTechArena ERP.\n\n` +
        `Vendor: ${exp.vendorName}\n` +
        `Invoice No: ${exp.invoiceNo || '—'}\n` +
        `Date Stocked In: ${exp.dateLabel}\n` +
        `Total units: ${exp.rowCount}\n\n` +
        `The attached workbook lists every unit in this entry.`;

      const okSent = await mailer.send({
        to,
        subject,
        text: body,
        attachments: [{ filename: exp.filename, content: exp.buffer }],
      });
      okSent ? result.sent++ : result.failed++;
    } catch (err) {
      result.failed++;
      logger.error({ err, key }, 'Daily backup: entry export failed');
    }
  }

  logger.info(result, 'Daily stock-in backup finished');
  return result;
}
