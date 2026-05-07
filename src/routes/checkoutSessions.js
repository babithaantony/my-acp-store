import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { idempotency } from '../middleware/idempotency.js';
import { sessionStore } from '../store/sessionStore.js';
import { sendOrderWebhook } from '../utils/webhook.js';

const router = Router();

router.use(idempotency);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function storeError(err, res) {
  const status = err.status ?? 500;
  const type = status === 404 ? 'invalid_request'
    : status === 405 ? 'invalid_request'
    : 'processing_error';
  return res.status(status).json({ type, code: err.code ?? 'internal_error', message: err.message });
}

// ─── POST /checkout_sessions ──────────────────────────────────────────────────

router.post('/', (req, res) => {
  const {
    line_items,
    currency,
    capabilities,
    buyer,
    fulfillment_address,
    fulfillment_details,
    selected_fulfillment_options,
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

  for (let i = 0; i < line_items.length; i++) {
    if (!line_items[i]?.id) {
      return res.status(422).json({
        type: 'invalid_request',
        code: 'invalid_line_item',
        message: `line_items[${i}].id is required`,
        param: `$.line_items[${i}].id`,
      });
    }
  }

  try {
    const session = sessionStore.create({
      rawItems: line_items,
      currency,
      capabilities,
      buyer: buyer ?? null,
      fulfillmentAddress: fulfillment_address ?? fulfillment_details?.address ?? null,
      shippingOption: selected_fulfillment_options?.[0] ?? null,
      extra: {
        ...(locale != null && { locale }),
        ...(timezone != null && { timezone }),
        ...(order_notes != null && { order_notes }),
        ...(metadata != null && { metadata }),
        ...(discounts != null && { discounts }),
        ...(affiliate_attribution != null && { affiliate_attribution }),
        ...(fulfillment_details != null && { fulfillment_details }),
        selected_fulfillment_options: selected_fulfillment_options ?? [],
      },
    });
    return res.status(201).json(session);
  } catch (err) {
    return storeError(err, res);
  }
});

// ─── PATCH /checkout_sessions/:id ────────────────────────────────────────────

router.patch('/:id', (req, res) => {
  const {
    buyer,
    fulfillment_address,
    fulfillment_details,
    selected_fulfillment_options,
    items,
    line_items,
    discounts,
    order_notes,
    metadata,
  } = req.body ?? {};

  // Accept both `items` and `line_items` naming
  const rawItems = items ?? line_items;

  // Derive the shipping option from the first selected fulfillment option
  const shippingOption =
    selected_fulfillment_options !== undefined
      ? (selected_fulfillment_options[0] ?? null)
      : undefined;

  try {
    const session = sessionStore.update(req.params.id, {
      ...(buyer !== undefined && { buyer }),
      ...(fulfillment_address !== undefined && { fulfillmentAddress: fulfillment_address }),
      ...(fulfillment_details !== undefined && {
        fulfillmentAddress: fulfillment_details.address ?? null,
      }),
      ...(shippingOption !== undefined && { shippingOption }),
      ...(rawItems !== undefined && { items: rawItems }),
      extra: {
        ...(discounts !== undefined && { discounts }),
        ...(order_notes !== undefined && { order_notes }),
        ...(metadata !== undefined && { metadata }),
        ...(selected_fulfillment_options !== undefined && { selected_fulfillment_options }),
        ...(fulfillment_details !== undefined && { fulfillment_details }),
      },
    });
    return res.json(session);
  } catch (err) {
    return storeError(err, res);
  }
});

// ─── POST /checkout_sessions/:id/items  (add or update a single item) ─────────

router.post('/:id/items', (req, res) => {
  if (!req.body?.id) {
    return res.status(422).json({
      type: 'invalid_request',
      code: 'missing_item_id',
      message: 'item id is required',
      param: '$.id',
    });
  }
  try {
    const session = sessionStore.addItem(req.params.id, req.body);
    return res.json(session);
  } catch (err) {
    return storeError(err, res);
  }
});

// ─── DELETE /checkout_sessions/:id/items/:variantId ───────────────────────────

router.delete('/:id/items/:variantId', (req, res) => {
  try {
    const session = sessionStore.removeItem(req.params.id, req.params.variantId);
    return res.json(session);
  } catch (err) {
    return storeError(err, res);
  }
});

// ─── POST /checkout_sessions/:id/complete ────────────────────────────────────

router.post('/:id/complete', (req, res) => {
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
      display_last4:
        payment_method.display_last4 ?? payment_method.number?.slice(-4) ?? null,
    },
  };

  try {
    const session = sessionStore.complete(req.params.id, order);

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
  } catch (err) {
    return storeError(err, res);
  }
});

// ─── POST /checkout_sessions/:id/cancel ──────────────────────────────────────

router.post('/:id/cancel', (req, res) => {
  try {
    const session = sessionStore.cancel(req.params.id, req.body?.intent_trace ?? null);
    return res.json(session);
  } catch (err) {
    return storeError(err, res);
  }
});

// ─── GET /checkout_sessions/:id ──────────────────────────────────────────────

router.get('/:id', (req, res) => {
  const session = sessionStore.get(req.params.id);
  if (!session) {
    return res.status(404).json({
      type: 'invalid_request',
      code: 'session_not_found',
      message: `Checkout session '${req.params.id}' not found`,
    });
  }
  return res.json(session);
});

export default router;
