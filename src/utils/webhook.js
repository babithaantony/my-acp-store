/**
 * Simulate delivering an ACP order webhook after checkout completion.
 * Logs the payload to stdout; if WEBHOOK_URL is set, sends an HTTP POST.
 */
export async function sendOrderWebhook(session, order) {
  const payload = {
    event: 'order.created',
    api_version: '2026-04-17',
    timestamp: new Date().toISOString(),
    data: {
      checkout_session_id: session.id,
      order_id: order.id,
      order_status: order.status,
      currency: session.currency,
      totals: session.totals,
      buyer: session.buyer ?? null,
      line_items: session.line_items,
      fulfillment_details: session.fulfillment_details ?? null,
    },
  };

  console.log(
    '[Webhook] Dispatching order.created event:\n',
    JSON.stringify(payload, null, 2)
  );

  const webhookUrl = process.env.WEBHOOK_URL;
  if (!webhookUrl) return;

  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-ACP-Event': 'order.created',
          'X-ACP-Delivery-Attempt': String(attempt),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });

      if (res.ok) {
        console.log(`[Webhook] Delivered on attempt ${attempt}: ${res.status}`);
        return;
      }

      console.warn(`[Webhook] Attempt ${attempt} failed: HTTP ${res.status}`);
    } catch (err) {
      console.warn(`[Webhook] Attempt ${attempt} error: ${err.message}`);
    }
  }

  console.error('[Webhook] All delivery attempts exhausted');
}
