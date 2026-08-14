import { TransactionType } from '@prisma/client';

export interface Actor {
  id: string;
  ip: string | null;
}

// Internal primitive parameters (signed quantity already resolved).
export interface LedgerMovementParams {
  productId: string;
  warehouseId: string;
  type: TransactionType;
  signedQty: number;
  unitCost?: number | null;
  vendorId?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
  remarks?: string | null;
  /**
   * When the movement actually happened. Entries are often recorded a day or
   * two after the fact, and without this every one of them lands on today —
   * which is what made a backdated dispatch show up under the wrong date.
   */
  occurredAt?: Date | null;
}

export interface MovementResult {
  newQuantity: number;
  transactionId: string;
}

export interface StockView {
  productId: string;
  warehouseId: string;
  warehouseName?: string;
  quantity: number;
}

export interface EanLookupResult {
  product: {
    id: string;
    ean: string;
    sku: string;
    model: string;
    brand: string;
    imeiRequired: boolean;
  };
  total: number;
  byWarehouse: StockView[];
}
