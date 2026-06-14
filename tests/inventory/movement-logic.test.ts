import { describe, it, expect } from 'vitest';
import { TransactionType, ImeiStatus } from '@prisma/client';
import { toSigned } from '../../src/modules/inventory/inventory.service';
import { isInStock, statusStockDelta } from '../../src/modules/imei/imei.service';

describe('toSigned — ledger direction', () => {
  it('inbound types are positive', () => {
    expect(toSigned(TransactionType.STOCK_IN, 5)).toBe(5);
    expect(toSigned(TransactionType.RETURN, 5)).toBe(5);
    expect(toSigned(TransactionType.CANCELLATION, 5)).toBe(5);
    expect(toSigned(TransactionType.TRANSFER_IN, 5)).toBe(5);
  });
  it('outbound types are negative regardless of input sign', () => {
    expect(toSigned(TransactionType.STOCK_OUT, 5)).toBe(-5);
    expect(toSigned(TransactionType.MARKETPLACE_DISPATCH, 5)).toBe(-5);
    expect(toSigned(TransactionType.TRANSFER_OUT, -5)).toBe(-5);
  });
  it('ADJUSTMENT passes the caller-signed value through', () => {
    expect(toSigned(TransactionType.ADJUSTMENT, -3)).toBe(-3);
    expect(toSigned(TransactionType.ADJUSTMENT, 7)).toBe(7);
  });
});

describe('IMEI status -> stock delta (keeps StockLevel == in-stock count)', () => {
  it('IN_STOCK is the only sellable state', () => {
    expect(isInStock(ImeiStatus.IN_STOCK)).toBe(true);
    expect(isInStock(ImeiStatus.SOLD)).toBe(false);
    expect(isInStock(ImeiStatus.OPEN_BOX)).toBe(false);
  });
  it('leaving IN_STOCK decrements by one', () => {
    expect(statusStockDelta(ImeiStatus.IN_STOCK, ImeiStatus.DAMAGED)).toBe(-1);
    expect(statusStockDelta(ImeiStatus.IN_STOCK, ImeiStatus.BLOCKED)).toBe(-1);
  });
  it('returning to IN_STOCK increments by one (restock)', () => {
    expect(statusStockDelta(ImeiStatus.RETURNED, ImeiStatus.IN_STOCK)).toBe(1);
  });
  it('non-stock to non-stock is neutral', () => {
    expect(statusStockDelta(ImeiStatus.SOLD, ImeiStatus.RETURNED)).toBe(0);
  });
});
