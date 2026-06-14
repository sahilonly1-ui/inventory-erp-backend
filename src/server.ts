import http from 'http';
import { createApp } from './app';
import { env } from './config/env';
import { prisma } from './config/prisma';
import { logger } from './config/logger';
import { initSocket } from './realtime/socket';

async function bootstrap() {
  const app = createApp();
  const server = http.createServer(app);

  server.listen(env.PORT, () => {
    logger.info(`ERP backend listening on :${env.PORT} [${env.NODE_ENV}]`);
  });

  initSocket(server); // live stock updates over websocket

  const shutdown = async (signal: string) => {
    logger.info(`${signal} received — shutting down`);
    server.close(async () => {
      await prisma.$disconnect();
      logger.info('Closed HTTP server and DB connections');
      process.exit(0);
    });
    // Force-exit if graceful close hangs.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => logger.error({ reason }, 'unhandledRejection'));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaughtException');
    process.exit(1);
  });
}

void bootstrap();
