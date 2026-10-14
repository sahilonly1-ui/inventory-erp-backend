export interface ReceiveImeiInput {
  productId: string;
  warehouseId: string;
  imeis: { imei1: string; imei2?: string | null; serialNo?: string | null; imeiType?: string }[];
  vendorId?: string | null;
  remarks?: string;
}

export interface DispatchImeiInput {
  imeis: string[];
  channel?: 'STOCK_OUT' | 'MARKETPLACE';
  referenceType?: string;
  referenceId?: string;
  remarks?: string;
}
