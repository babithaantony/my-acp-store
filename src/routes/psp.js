import { Router } from 'express';
import { idempotency } from '../middleware/idempotency.js';
import { createToken } from '../store/pspStore.js';
import {
  sanitize,
  detectBrand,
  luhnCheck,
  isExpired,
  getTestOutcome,
} from '../utils/cardUtils.js';

const router = Router();
router.use(idempotency);

/**
 * POST /psp/tokens
 *
 * Mock PSP tokenization. Accepts card details, validates their shape,
 * and returns a valid ACP-shaped delegated payment token (vt_...).
 * No real card network calls are made.
 *
 * Request body:
 *   card        {object}  required — card details (see validation below)
 *   allowance   {object}  optional — ACP allowance constraints
 *
 * Special test cards (deterministic outcomes for testing):
 *   4242 4242 4242 4242  → success (Visa)
 *   4000 0000 0000 0002  → card_declined
 *   4000 0000 0000 9995  → insufficient_funds
 *   4000 0000 0000 0069  → expired_card
 *   4000 0000 0000 0127  → incorrect_cvc
 *   4000 0000 0000 0119  → processing_error
 */
router.post('/tokens', (req, res) => {
  const { card, allowance } = req.body ?? {};

  // ── Validate card presence ──────────────────────────────────────────────────
  if (!card || typeof card !== 'object') {
    return res.status(422).json({
      type: 'invalid_request',
      code: 'missing_card',
      message: 'card is required',
      param: '$.card',
    });
  }

  const { number, exp_month, exp_year, name, cvc } = card;

  if (!number) {
    return res.status(422).json({
      type: 'invalid_request',
      code: 'missing_card_number',
      message: 'card.number is required',
      param: '$.card.number',
    });
  }
  if (!exp_month || !exp_year) {
    return res.status(422).json({
      type: 'invalid_request',
      code: 'missing_card_expiry',
      message: 'card.exp_month and card.exp_year are required',
      param: '$.card.exp_month',
    });
  }
  if (!name) {
    return res.status(422).json({
      type: 'invalid_request',
      code: 'missing_cardholder_name',
      message: 'card.name (cardholder name) is required',
      param: '$.card.name',
    });
  }

  // ── Validate card number format ─────────────────────────────────────────────
  const pan = sanitize(number);

  if (!/^\d{13,19}$/.test(pan)) {
    return res.status(422).json({
      type: 'invalid_request',
      code: 'invalid_card_number',
      message: 'card.number must be 13–19 digits',
      param: '$.card.number',
    });
  }

  if (!luhnCheck(pan)) {
    return res.status(422).json({
      type: 'invalid_request',
      code: 'invalid_card_number',
      message: 'card.number failed Luhn validation',
      param: '$.card.number',
    });
  }

  // ── Validate expiry ─────────────────────────────────────────────────────────
  const month = parseInt(exp_month, 10);
  const year = parseInt(exp_year, 10);

  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return res.status(422).json({
      type: 'invalid_request',
      code: 'invalid_expiry_month',
      message: 'card.exp_month must be between 1 and 12',
      param: '$.card.exp_month',
    });
  }

  if (!Number.isInteger(year) || year < 2000) {
    return res.status(422).json({
      type: 'invalid_request',
      code: 'invalid_expiry_year',
      message: 'card.exp_year must be a 4-digit year',
      param: '$.card.exp_year',
    });
  }

  if (isExpired(month, year)) {
    return res.status(422).json({
      type: 'invalid_request',
      code: 'expired_card',
      message: 'The card has expired',
      param: '$.card.exp_year',
    });
  }

  // ── Check for test-card decline triggers ────────────────────────────────────
  const testOutcome = getTestOutcome(pan);
  if (testOutcome) {
    return res.status(402).json({
      type: 'invalid_request',
      code: testOutcome.code,
      message: testOutcome.message,
      param: '$.card.number',
    });
  }

  // ── Build sanitised card metadata (never store full PAN) ────────────────────
  const brand = detectBrand(pan);
  const last4 = pan.slice(-4);
  const iin = pan.slice(0, 6);

  const cardMeta = {
    card_number_type: 'fpan',
    display_brand: brand,
    display_last4: last4,
    iin,
    exp_month: month,
    exp_year: year,
    name,
    checks_performed: ['luhn', ...(cvc ? ['cvv'] : [])],
  };

  // ── Validate allowance constraints (if provided) ────────────────────────────
  if (allowance !== undefined) {
    if (allowance.max_amount !== undefined && (!Number.isInteger(allowance.max_amount) || allowance.max_amount <= 0)) {
      return res.status(422).json({
        type: 'invalid_request',
        code: 'invalid_allowance',
        message: 'allowance.max_amount must be a positive integer (minor currency units)',
        param: '$.allowance.max_amount',
      });
    }
    if (allowance.currency !== undefined && !/^[a-zA-Z]{3}$/.test(allowance.currency)) {
      return res.status(422).json({
        type: 'invalid_request',
        code: 'invalid_allowance',
        message: 'allowance.currency must be a 3-letter ISO 4217 code',
        param: '$.allowance.currency',
      });
    }
  }

  // ── Issue the vault token ───────────────────────────────────────────────────
  const token = createToken(cardMeta, allowance);

  return res.status(201).json(token);
});

export default router;
