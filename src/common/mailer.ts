import nodemailer, { Transporter } from 'nodemailer';
import { logger } from '../config/logger';

export interface MailAttachment {
  filename: string;
  content: Buffer;
}

let transporter: Transporter | null = null;
let initialised = false;

/**
 * Build the SMTP transport once, from env.
 *
 * Mail is optional: if SMTP isn't configured the app still boots and every
 * send becomes a logged no-op, so a missing credential can never take the
 * inventory system down.
 */
function getTransporter(): Transporter | null {
  if (initialised) return transporter;
  initialised = true;

  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    logger.warn('SMTP not configured (SMTP_HOST / SMTP_USER / SMTP_PASS) — outgoing mail is disabled');
    return null;
  }

  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465, // 465 is implicit TLS; 587 upgrades via STARTTLS
    auth: { user, pass },
  });

  logger.info({ host, port }, 'SMTP transport ready');
  return transporter;
}

export const mailer = {
  get isConfigured(): boolean {
    return getTransporter() !== null;
  },

  async send(opts: {
    to: string;
    subject: string;
    text: string;
    html?: string;
    attachments?: MailAttachment[];
  }): Promise<boolean> {
    const tx = getTransporter();
    if (!tx) {
      logger.warn({ to: opts.to, subject: opts.subject }, 'Mail skipped — SMTP not configured');
      return false;
    }
    try {
      await tx.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: opts.to,
        subject: opts.subject,
        text: opts.text,
        html: opts.html,
        attachments: opts.attachments,
      });
      logger.info({ to: opts.to, subject: opts.subject }, 'Mail sent');
      return true;
    } catch (err) {
      logger.error({ err, to: opts.to, subject: opts.subject }, 'Mail send failed');
      return false;
    }
  },
};
