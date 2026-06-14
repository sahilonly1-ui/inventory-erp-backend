export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;
  public readonly isOperational = true;

  constructor(message: string, statusCode = 500, code = 'INTERNAL_ERROR', details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad request', details?: unknown) { super(message, 400, 'BAD_REQUEST', details); }
}
export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') { super(message, 401, 'UNAUTHORIZED'); }
}
export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') { super(message, 403, 'FORBIDDEN'); }
}
export class NotFoundError extends AppError {
  constructor(message = 'Not found') { super(message, 404, 'NOT_FOUND'); }
}
export class ConflictError extends AppError {
  constructor(message = 'Conflict', details?: unknown) { super(message, 409, 'CONFLICT', details); }
}

export class InsufficientStockError extends AppError {
  constructor(productId: string, warehouseId: string, available: number, delta: number) {
    super(
      `Insufficient stock for product ${productId} at warehouse ${warehouseId}: available ${available}, requested ${Math.abs(delta)}`,
      409,
      'INSUFFICIENT_STOCK',
      { productId, warehouseId, available, requested: Math.abs(delta) },
    );
  }
}

export class ReconciliationError extends AppError {
  constructor(details: unknown) {
    super('Stock reconciliation mismatch', 409, 'RECONCILIATION_MISMATCH', details);
  }
}
