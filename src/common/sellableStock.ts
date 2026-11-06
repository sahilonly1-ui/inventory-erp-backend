/**
 * How many units of a product can actually be sold today, as a SQL expression.
 *
 * `alias` is the products table alias in the surrounding query.
 *
 * This is the same rule the Stock Report and the Specifications sheet use. For a
 * product that has IMEI / serial units, only regular (imeiType NIL) units that
 * are IN_STOCK count — demo and open-box units do not, however they were marked
 * (by type at scan time or by status afterwards), and a sold unit is not held
 * stock. Without such units the stock level is the count.
 *
 * Market Prices used a plain SUM of the stock level instead, and that includes
 * demo and open-box units, so a product whose only stock was a demo phone stayed
 * on the list.
 *
 * Statuses are compared as text so this keeps working on a database whose enum
 * has not been given DEMO yet.
 */
export function sellableStockSql(alias = 'p'): string {
  return `(
    SELECT CASE WHEN x.total > 0 OR x.held > 0 THEN x.total
                ELSE COALESCE((SELECT SUM(sl.quantity) FROM stock_levels sl WHERE sl."productId" = ${alias}.id), 0) END
    FROM (
      SELECT
        COUNT(*) FILTER (WHERE u."imeiType" = 'NIL' AND u.status::text = 'IN_STOCK') AS total,
        COUNT(*) FILTER (WHERE u.status::text <> 'SOLD'
                           AND (u."imeiType" IN ('DEMO', 'OPEN_BOX') OR u.status::text IN ('DEMO', 'OPEN_BOX'))) AS held
      FROM imei_inventory u
      WHERE u."productId" = ${alias}.id AND u."isDeleted" = false
    ) x
  )`;
}
