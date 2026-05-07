import { v4 as uuidv4 } from 'uuid';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(
  readFileSync(join(__dirname, '../data/products.json'), 'utf-8')
);

const TAX_RATE = parseFloat(process.env.TAX_RATE ?? '0.10');
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

// ─── Catalog helpers ──────────────────────────────────────────────────────────

function findVariant(variantId) {
  for (const product of catalog) {
    const variant = product.variants.find((v) => v.id === variantId);
    if (variant) return { product, variant };
  }
  return null;
}

function enrichItem(raw) {
  const entry = findVariant(raw.id);
  const unitAmount = raw.unit_amount ?? entry?.variant.price?.amount ?? 0;
  const quantity = Math.max(parseInt(raw.quantity) || 1, 1);
  const name =
    raw.name ??
    (entry ? `${entry.product.title} — ${entry.variant.title}` : raw.id);
  const images = (entry?.variant.media ?? entry?.product.media ?? [])
    .filter((m) => m.type === 'image')
    .map((m) => m.url);

  return {
    id: raw.id,
    line_item_id: raw.line_item_id ?? `li_${uuidv4().replace(/-/g, '').slice(0, 20)}`,
    name,
    unit_amount: unitAmount,
    quantity,
    subtotal: unitAmount * quantity,
    images,
    variant_options: entry?.variant.variant_options ?? [],
    availability_status: entry?.variant.availability?.status ?? 'in_stock',
    product_id: entry?.product.id ?? null,
    variant_id: entry?.variant.id ?? null,
  };
}

// ─── Totals calculation ───────────────────────────────────────────────────────

function recalculate(session) {
  const subtotal = session.items.reduce((sum, i) => sum + i.unit_amount * i.quantity, 0);
  const shipping = session.shipping_option?.cost?.amount ?? 0;
  const tax = Math.round((subtotal + shipping) * TAX_RATE);
  const total = subtotal + shipping + tax;

  session.subtotal = subtotal;
  session.tax = tax;
  session.shipping = shipping;
  session.total = total;

  // Keep ACP-compatible totals array in sync
  const totals = [
    { type: 'items_base_amount', display_text: 'Items', amount: subtotal },
    { type: 'subtotal', display_text: 'Subtotal', amount: subtotal },
  ];
  if (shipping > 0) {
    const label = session.shipping_option?.carrier_name
      ? `Shipping — ${session.shipping_option.carrier_name}`
      : 'Shipping';
    totals.push({ type: 'fulfillment', display_text: label, amount: shipping });
  }
  totals.push({ type: 'tax', display_text: 'Estimated Tax', amount: tax });
  totals.push({ type: 'total', display_text: 'Total', amount: total });
  session.totals = totals;

  // Sync line-item subtotals too
  for (const item of session.items) {
    item.subtotal = item.unit_amount * item.quantity;
  }
}

// ─── SessionStore ─────────────────────────────────────────────────────────────

class SessionStore {
  #store = new Map();

  /**
   * Create a new checkout session.
   * @param {object} opts
   * @param {Array}  opts.rawItems        - Array of { id, quantity?, unit_amount?, name? }
   * @param {string} opts.currency
   * @param {object} opts.capabilities
   * @param {object} [opts.buyer]
   * @param {object} [opts.fulfillmentAddress]
   * @param {object} [opts.shippingOption]
   * @param {object} [opts.extra]         - Remaining ACP fields (locale, metadata, etc.)
   */
  create({ rawItems, currency, capabilities, buyer = null, fulfillmentAddress = null, shippingOption = null, extra = {} }) {
    const now = new Date();

    const session = {
      id: `cs_${uuidv4().replace(/-/g, '').slice(0, 20)}`,
      status: 'open',
      currency: currency.toUpperCase(),
      items: rawItems.map(enrichItem),
      buyer,
      fulfillment_address: fulfillmentAddress,
      shipping_option: shippingOption,
      // flat totals — set by recalculate()
      subtotal: 0,
      tax: 0,
      shipping: 0,
      total: 0,
      totals: [],
      capabilities,
      messages: [],
      expires_at: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
      created_at: now.toISOString(),
      updated_at: null,
      completed_at: null,
      canceled_at: null,
      order: null,
      ...extra,
    };

    recalculate(session);
    this.#store.set(session.id, session);
    return session;
  }

  /** @returns {object|null} */
  get(id) {
    return this.#store.get(id) ?? null;
  }

  /**
   * Apply a partial update and recalculate totals if items or shipping changed.
   * @param {string} id
   * @param {object} patch  - { buyer?, fulfillmentAddress?, shippingOption?, items?, extra? }
   */
  update(id, patch) {
    const session = this.#assertOpen(id);
    let needsRecalc = false;

    if (patch.buyer !== undefined) session.buyer = patch.buyer;

    if (patch.fulfillmentAddress !== undefined) {
      session.fulfillment_address = patch.fulfillmentAddress;
    }

    if (patch.shippingOption !== undefined) {
      session.shipping_option = patch.shippingOption;
      needsRecalc = true;
    }

    if (patch.items !== undefined) {
      session.items = patch.items.map((raw) =>
        enrichItem({ ...raw, line_item_id: raw.line_item_id })
      );
      needsRecalc = true;
    }

    if (patch.extra) Object.assign(session, patch.extra);

    if (needsRecalc) recalculate(session);
    session.updated_at = new Date().toISOString();
    return session;
  }

  /**
   * Add or update a single item by variant ID.
   * If an item with the same id already exists its quantity and unit_amount are merged.
   */
  addItem(id, rawItem) {
    const session = this.#assertOpen(id);
    const existing = session.items.find((i) => i.id === rawItem.id);

    if (existing) {
      if (rawItem.quantity != null) existing.quantity = Math.max(parseInt(rawItem.quantity), 1);
      if (rawItem.unit_amount != null) existing.unit_amount = rawItem.unit_amount;
    } else {
      session.items.push(enrichItem(rawItem));
    }

    recalculate(session);
    session.updated_at = new Date().toISOString();
    return session;
  }

  /**
   * Remove an item by variant ID (item.id).
   * Returns null for the item if not found (no error — idempotent).
   */
  removeItem(sessionId, variantId) {
    const session = this.#assertOpen(sessionId);
    session.items = session.items.filter((i) => i.id !== variantId);
    recalculate(session);
    session.updated_at = new Date().toISOString();
    return session;
  }

  /** Mark the session complete and attach the order object. */
  complete(id, order) {
    const session = this.#assertOpen(id);
    session.status = 'complete';
    session.order = order;
    session.completed_at = new Date().toISOString();
    return session;
  }

  /** Mark the session cancelled. */
  cancel(id, intentTrace = null) {
    const session = this.#store.get(id);
    if (!session) return null;
    if (session.status === 'complete') {
      const err = new Error("Cannot cancel a completed session");
      err.code = 'session_already_completed';
      err.status = 405;
      throw err;
    }
    session.status = 'cancelled';
    session.canceled_at = new Date().toISOString();
    if (intentTrace != null) session.intent_trace = intentTrace;
    return session;
  }

  // ── private ──────────────────────────────────────────────────────────────

  #assertOpen(id) {
    const session = this.#store.get(id);
    if (!session) {
      const err = new Error(`Checkout session '${id}' not found`);
      err.code = 'session_not_found';
      err.status = 404;
      throw err;
    }
    if (session.status === 'complete' || session.status === 'cancelled') {
      const err = new Error(`Cannot modify a checkout session in status '${session.status}'`);
      err.code = 'session_not_updatable';
      err.status = 405;
      throw err;
    }
    return session;
  }
}

export const sessionStore = new SessionStore();
