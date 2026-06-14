import express, { Application } from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import cors from 'cors';
import { env } from './config/env';
import { globalLimiter } from './middlewares/rateLimiter';
import { errorHandler, notFoundHandler } from './middlewares/errorHandler';
import apiRoutes from './routes';
import { logger } from './config/logger';

export function createApp(): Application {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Railway sits behind a proxy; needed for req.ip + rate limiting.

  app.use(pinoHttp({ logger }));
  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGINS === '*' ? true : env.CORS_ORIGINS.split(',').map((o) => o.trim()),
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(globalLimiter);

  app.use('/api/v1', apiRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
