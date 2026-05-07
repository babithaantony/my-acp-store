const TAX_RATE = parseFloat(process.env.TAX_RATE ?? '0.10');

/**
 * Compute order-level totals for a checkout session.
 * @param {Array} lineItems  - Built LineItem objects (with unit_amount + quantity)
 * @param {Object|null} fulfillmentOption - First selected fulfillment option, or null
 * @returns {Array<Total>}
 */
export function computeOrderTotals(lineItems, fulfillmentOption = null) {
  const itemsBaseAmount = lineItems.reduce(
    (sum, li) => sum + li.unit_amount * li.quantity,
    0
  );

  const fulfillmentAmount = fulfillmentOption?.cost?.amount ?? 0;
  const subtotal = itemsBaseAmount;
  const tax = Math.round((subtotal + fulfillmentAmount) * TAX_RATE);
  const total = subtotal + fulfillmentAmount + tax;

  const totals = [
    {
      type: 'items_base_amount',
      display_text: 'Items',
      amount: itemsBaseAmount,
    },
    { type: 'subtotal', display_text: 'Subtotal', amount: subtotal },
  ];

  if (fulfillmentAmount > 0) {
    const label =
      fulfillmentOption?.carrier_name
        ? `Shipping — ${fulfillmentOption.carrier_name}`
        : 'Shipping';
    totals.push({ type: 'fulfillment', display_text: label, amount: fulfillmentAmount });
  }

  totals.push({ type: 'tax', display_text: 'Estimated Tax', amount: tax });
  totals.push({ type: 'total', display_text: 'Total', amount: total });

  return totals;
}

/**
 * Compute line-item-level totals.
 */
export function computeLineItemTotals(unitAmount, quantity) {
  const baseAmount = unitAmount * quantity;
  return [
    { type: 'items_base_amount', display_text: 'Item Total', amount: baseAmount },
    { type: 'subtotal', display_text: 'Subtotal', amount: baseAmount },
    { type: 'total', display_text: 'Total', amount: baseAmount },
  ];
}
