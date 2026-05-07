// Standalone total helpers — used outside of SessionStore when needed.
// SessionStore calls recalculate() internally; these are exported for tests
// or any route that needs to preview totals without creating a session.

const TAX_RATE = parseFloat(process.env.TAX_RATE ?? '0.10');

/**
 * @param {Array<{unit_amount: number, quantity: number}>} items
 * @param {number} shippingAmount  - in minor currency units
 * @returns {{ subtotal, tax, shipping, total, totals }}
 */
export function computeTotals(items, shippingAmount = 0) {
  const subtotal = items.reduce((s, i) => s + i.unit_amount * i.quantity, 0);
  const tax = Math.round((subtotal + shippingAmount) * TAX_RATE);
  const total = subtotal + shippingAmount + tax;
  return { subtotal, tax, shipping: shippingAmount, total };
}
