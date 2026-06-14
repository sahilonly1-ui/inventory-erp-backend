import pino from 'pino';
import { isProd } from './env';

export const logger = pino({
  level: isProd ? 'info' : 'debug',
  base: { service: 'erp-backend' },
  redact: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.passwordHash'],
  transport: isProd ? undefined : { target: 'pino-pretty', options: { colorize: true } },
});
