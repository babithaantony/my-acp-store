// ─── Brand detection ──────────────────────────────────────────────────────────

const BRAND_PATTERNS = [
  { brand: 'amex',       pattern: /^3[47]/ },
  { brand: 'diners',     pattern: /^3(0[0-5]|[68])/ },
  { brand: 'discover',   pattern: /^(6011|622(1(2[6-9]|[3-9]\d)|[2-8]\d{2}|9([01]\d|2[0-5]))|64[4-9]|65)/ },
  { brand: 'jcb',        pattern: /^35(2[89]|[3-8])/ },
  { brand: 'mastercard', pattern: /^(5[1-5]|2(2[2-9][1-9]|[3-6]\d{2}|7[01]\d|720))/ },
  { brand: 'unionpay',   pattern: /^62/ },
  { brand: 'visa',       pattern: /^4/ },
];

export function detectBrand(number) {
  const n = sanitize(number);
  return BRAND_PATTERNS.find((b) => b.pattern.test(n))?.brand ?? 'unknown';
}

// ─── Sanitize ────────────────────────────────────────────────────────────────

export function sanitize(number) {
  return String(number ?? '').replace(/[\s\-]/g, '');
}

// ─── Luhn check ──────────────────────────────────────────────────────────────

export function luhnCheck(number) {
  const digits = sanitize(number).split('').reverse().map(Number);
  if (digits.length < 13 || digits.length > 19) return false;
  const sum = digits.reduce((acc, d, i) => {
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    return acc + d;
  }, 0);
  return sum % 10 === 0;
}

// ─── Expiry ───────────────────────────────────────────────────────────────────

export function isExpired(month, year) {
  const now = new Date();
  const expiry = new Date(year, month - 1 + 1, 1); // first day of month after expiry
  return expiry <= now;
}

// ─── Well-known test cards ────────────────────────────────────────────────────
// These are standard test card numbers (e.g. Stripe-style) that trigger
// specific simulated declines so callers can test error paths.

const TEST_CARD_OUTCOMES = new Map([
  ['4000000000000002', { code: 'card_declined',        message: 'Your card was declined.' }],
  ['4000000000009995', { code: 'insufficient_funds',   message: 'Your card has insufficient funds.' }],
  ['4000000000000069', { code: 'expired_card',         message: 'Your card has expired.' }],
  ['4000000000000127', { code: 'incorrect_cvc',        message: 'Your card\'s security code is incorrect.' }],
  ['4000000000000119', { code: 'processing_error',     message: 'An error occurred while processing your card.' }],
]);

/** Returns a decline descriptor if the card number is a known test-decline card, else null. */
export function getTestOutcome(number) {
  return TEST_CARD_OUTCOMES.get(sanitize(number)) ?? null;
}
