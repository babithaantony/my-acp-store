import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { idempotency } from '../middleware/idempotency.js';
import { computeOrderTotals, computeLineItemTotals } from '../utils/totals.js';
import { sendOrderWebhook } from '../utils/webhook.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(
  readFileSync(join(__dirname, '../data/products.json'), 'utf-8')
);

// In-memory session store
const sessions = new Map();

const router = Router();

// Apply idempotency to all POST requests in this router
router.use(idempotency);

// ─── Helpers ────────────────────────────────────────────────────────────────

function findVariant(variantId) {
  for (const product of catalog) {
    const variant = product.variants.find((v) => v.id === variantId);
    if (variant) return { product, variant };
  }
  return null;
}

function buildLineItem(reqItem) {
  const catalogEntry = findVariant(reqItem.id);

  const unitAmount =
    reqItem.unit_amount ??
    catalogEntry?.variant.price?.amount ??
    0;

  const name =
    reqItem.name ??
    (catalogEntry
      ? `${catalogEntry.product.title} — ${catalogEntry.variant.title}`
      : reqItem.id);

  const images = (catalogEntry?.variant.media ?? catalogEntry?.product.media ?? [])
    .filter((m) => m.type === 'image')
    .map((m) => m.url);

  const variantOptions = catalogEntry?.variant.variant_options ?? [];
  const availabilityStatus =
    catalogEntry?.variant.availability?.status ?? 'in_stock';

  const quantity = Math.max(parseInt(reqItem.quantity) || 1, 1);

  return {
    id: `li_${uuidv4().replace(/-/g, '').slice(0, 20)}`,
    item: { id: reqItem.id, name, unit_amount: unitAmount },
    quantity,
    name,
    unit_amount: unitAmount,
    product_id: catalogEntry?.product.id ?? null,
    variant_id: catalogEntry?.variant.id ?? null,
    variant_options: variantOptions,
    images,
    availability_status: availabilityStatus,
    totals: computeLineItemTotals(unitAmount, quantity),
  };
}

function sessionNotFound(id, res) {
  return res.status(404).json({
    type: 'invalid_request',
    code: 'session_not_found',
    message: `Checkout session '${id}' not found`,
  });
}

// ─── POST /checkout_sessions ─────────────────────────────────────────────────

router.post('/', (req, res) => {
  const {
    line_items,
    currency,
    capabilities,
    buyer,
    fulfillment_details,
    affiliate_attribution,
    discounts,
    locale,
    timezone,
    order_notes,
    metadata,
  } = req.body ?? {};

  if (!Array.isArray(line_items) || line_items.length === 0) {
    return res.status(422).json({
      type: 'invalid_request',
      code: 'missing_line_items',
      message: 'line_items must be a non-empty array',
      param: '$.line_items',
    });
  }

  if (!currency) {
    return res.status(422).json({
      type: 'invalid_request',
      code: 'missing_currency',
      message: 'currency is required',
      param: '$.currency',
    });
  }

  if (!capabilities) {
    return res.status(422).json({
      type: 'invalid_request',
      code: 'missing_capabilities',
      message: 'capabilities is required',
      param: '$.capabilities',
    });
  }

  // Validate and enrich each line item against the catalog
  const builtLineItems = [];
  for (let i = 0; i < line_items.length; i++) {
    const item = line_items[i];

    if (!item?.id) {
      return res.status(422).json({
        type: 'invalid_request',
        code: 'invalid_line_item',
        message: `line_items[${i}].id is required`,
        param: `$.line_items[${i}].id`,
      });
    }

    const inCatalog = findVariant(item.id);
    if (!inCatalog && item.unit_amount == null) {
      return res.status(422).json({
        type: 'invalid_request',
        code: 'item_not_found',
        message: `Item '${item.id}' was not found in the catalog. Provide unit_amount to override.`,
        param: `$.line_items[${i}].id`,
      });
    }

    builtLineItems.push(buildLineItem(item));
  }

  const now = new Date();
  const session = {
    id: `cs_${uuidv4().replace(/-/g, '').slice(0, 20)}`,
    state: 'created',
    currency: currency.toUpperCase(),
    line_items: builtLineItems,
    buyer: buyer ?? null,
    fulfillment_details: fulfillment_details ?? null,
    selected_fulfillment_options: [],
    capabilities,
    totals: computeOrderTotals(builtLineItems),
    messages: [],
    expires_at: new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
    created_at: now.toISOString(),
    ...(locale != null && { locale }),
    ...(timezone != null && { timezone }),
    ...(order_notes != null && { order_notes }),
    ...(metadata != null && { metadata }),
    ...(discounts != null && { discounts }),
    ...(affiliate_attribution != null && { affiliate_attribution }),
  };

  sessions.set(session.id, session);

  return res.status(201).json(session);
});

// ─── PATCH /checkout_sessions/:id ────────────────────────────────────────────

router.patch('/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return sessionNotFound(req.params.id, res);

  if (session.state === 'completed' || session.state === 'canceled') {
    return res.status(405).json({
      type: 'invalid_request',
      code: 'session_not_updatable',
      message: `Cannot update a checkout session in state '${session.state}'`,
    });
  }

  const {
    buyer,
    fulfillment_details,
    selected_fulfillment_options,
    discounts,
    order_notes,
    metadata,
  } = req.body ?? {};

  if (buyer !== undefined) session.buyer = buyer;
  if (fulfillment_details !== undefined) session.fulfillment_details = fulfillment_details;
  if (order_notes !== undefined) session.order_notes = order_notes;
  if (metadata !== undefined) session.metadata = metadata;
  if (discounts !== undefined) session.discounts = discounts;

  if (selected_fulfillment_options !== undefined) {
    session.selected_fulfillment_options = selected_fulfillment_options;
    session.totals = computeOrderTotals(
      session.line_items,
      selected_fulfillment_options[0] ?? null
    );
  }

  session.state = 'updated';
  session.updated_at = new Date().toISOString();

  return res.json(session);
});

// ─── POST /checkout_sessions/:id/complete ────────────────────────────────────

router.post('/:id/complete', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return sessionNotFound(req.params.id, res);

  if (session.state === 'completed') {
    return res.status(405).json({
      type: 'invalid_request',
      code: 'session_already_completed',
      message: 'This checkout session has already been completed',
    });
  }

  if (session.state === 'canceled') {
    return res.status(405).json({
      type: 'invalid_request',
      code: 'session_canceled',
      message: 'Cannot complete a canceled checkout session',
    });
  }

  const { payment_method, affiliate_attribution } = req.body ?? {};

  if (!payment_method) {
    return res.status(422).json({
      type: 'invalid_request',
      code: 'missing_payment_method',
      message: 'payment_method is required to complete a checkout session',
      param: '$.payment_method',
    });
  }

  if (!payment_method.type) {
    return res.status(422).json({
      type: 'invalid_request',
      code: 'invalid_payment_method',
      message: 'payment_method.type is required',
      param: '$.payment_method.type',
    });
  }

  const order = {
    id: `ord_${uuidv4().replace(/-/g, '').slice(0, 20)}`,
    status: 'confirmed',
    created_at: new Date().toISOString(),
    payment_method: {
      type: payment_method.type,
      display_brand: payment_method.display_brand ?? null,
      display_last4: payment_method.display_last4 ?? payment_method.number?.slice(-4) ?? null,
    },
  };

  session.state = 'completed';
  session.order = order;
  session.completed_at = new Date().toISOString();

  if (affiliate_attribution) {
    session.affiliate_attribution = {
      ...(session.affiliate_attribution ?? {}),
      ...affiliate_attribution,
      touchpoint: 'last',
    };
  }

  sendOrderWebhook(session, order).catch((err) =>
    console.error('[Webhook] Dispatch error:', err.message)
  );

  return res.json(session);
});

// ─── POST /checkout_sessions/:id/cancel ──────────────────────────────────────

router.post('/:id/cancel', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return sessionNotFound(req.params.id, res);

  if (session.state === 'completed') {
    return res.status(405).json({
      type: 'invalid_request',
      code: 'session_already_completed',
      message: 'Cannot cancel a completed checkout session',
    });
  }

  if (session.state === 'canceled') {
    return res.status(405).json({
      type: 'invalid_request',
      code: 'session_already_canceled',
      message: 'This checkout session is already canceled',
    });
  }

  const { intent_trace } = req.body ?? {};

  session.state = 'canceled';
  session.canceled_at = new Date().toISOString();
  if (intent_trace != null) session.intent_trace = intent_trace;

  return res.json(session);
});

// ─── GET /checkout_sessions/:id ──────────────────────────────────────────────

router.get('/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return sessionNotFound(req.params.id, res);
  return res.json(session);
});

export default router;
