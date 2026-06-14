import { Server as HttpServer } from 'http';
import { Server as IOServer, Socket } from 'socket.io';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { verifyAccessToken } from '../utils/jwt.util';
import { domainEvents, StockChangedEvent } from '../common/events';

// Attaches Socket.IO to the HTTP server, authenticates each connection with the
// same access token, and broadcasts stock changes to connected dashboards.
export function initSocket(server: HttpServer): IOServer {
  const io = new IOServer(server, {
    cors: { origin: env.CORS_ORIGINS === '*' ? true : env.CORS_ORIGINS.split(',').map((o) => o.trim()) },
  });

  io.use((socket: Socket, next) => {
    const token = (socket.handshake.auth?.token as string | undefined) ?? '';
    try {
      const payload = verifyAccessToken(token);
      socket.data.userId = payload.sub;
      next();
    } catch {
      next(new Error('Unauthorized'));
    }
  });

  io.on('connection', (socket: Socket) => {
    logger.debug({ userId: socket.data.userId }, 'socket connected');
    socket.on('disconnect', () => logger.debug({ userId: socket.data.userId }, 'socket disconnected'));
  });

  // Bridge domain events -> websocket clients.
  domainEvents.on('stock.changed', (e: StockChangedEvent) => {
    io.emit('stock.changed', e);
  });

  return io;
}
