import { EventEmitter } from 'events';

export interface StockChangedEvent {
  productId: string;
  warehouseId: string;
  quantity: number;
  type: string;
}

// Emitted AFTER a movement transaction commits. A later phase attaches
// Socket.IO listeners here to push live stock updates to dashboards.
export const domainEvents = new EventEmitter();

export const emitStockChanged = (event: StockChangedEvent): void => {
  domainEvents.emit('stock.changed', event);
};
