import cron from 'node-cron';
import { logger } from './config/logger';
import { sendDailyStockInBackup } from './modules/reports/dailyBackup.service';

// Day-end in the showroom's timezone, not the server's — Render runs UTC, so
// without this the "daily" mail would fire mid-afternoon local time and miss
// the evening's stock-in.
const TZ = process.env.BACKUP_TZ || 'Asia/Kolkata';
const SCHEDULE = process.env.BACKUP_CRON || '30 22 * * *'; // 10:30 PM IST

function todayInTz(tz: string): string {
  // en-CA formats as YYYY-MM-DD, which is what the query helpers expect.
  return new Date().toLocaleDateString('en-CA', { timeZone: tz });
}

export function startScheduler(): void {
  if (process.env.BACKUP_ENABLED === 'false') {
    logger.info('Daily backup scheduler disabled via BACKUP_ENABLED=false');
    return;
  }
  if (!cron.validate(SCHEDULE)) {
    logger.error({ SCHEDULE }, 'Invalid BACKUP_CRON — scheduler not started');
    return;
  }

  cron.schedule(SCHEDULE, async () => {
    const date = todayInTz(TZ);
    logger.info({ date }, 'Daily stock-in backup starting');
    try {
      await sendDailyStockInBackup(date);
    } catch (err) {
      // Never let a scheduled failure bubble into an unhandled rejection.
      logger.error({ err }, 'Daily stock-in backup threw');
    }
  }, { timezone: TZ });

  logger.info({ schedule: SCHEDULE, timezone: TZ }, 'Daily stock-in backup scheduled');
}
