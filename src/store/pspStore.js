import { v4 as uuidv4 } from 'uuid';

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

// vault_token_id -> token record
const vault = new Map();

/**
 * Create and store a new vault token.
 *
 * @param {object} card       - Sanitised card metadata (no full PAN stored)
 * @param {object} allowance  - ACP allowance object
 * @returns {object}          - Full token record
 */
export function createToken(card, allowance) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + TOKEN_TTL_MS);

  const token = {
    vault_token_id: `vt_${uuidv4().replace(/-/g, '').slice(0, 24)}`,
    status: 'active',
    card,
    allowance: {
      reason: allowance?.reason ?? 'one_time',
      max_amount: allowance?.max_amount ?? null,
      currency: allowance?.currency?.toLowerCase() ?? null,
      checkout_session_id: allowance?.checkout_session_id ?? null,
      merchant_id: allowance?.merchant_id ?? null,
      expires_at: expiresAt.toISOString(),
    },
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
  };

  vault.set(token.vault_token_id, token);
  return token;
}

/**
 * Retrieve a token by ID. Returns null if not found or expired.
 */
export function getToken(id) {
  const token = vault.get(id);
  if (!token) return null;
  if (new Date(token.expires_at) <= new Date()) {
    token.status = 'expired';
  }
  return token;
}

/**
 * Mark a token as used (one-time tokens cannot be reused).
 */
export function consumeToken(id) {
  const token = vault.get(id);
  if (token) token.status = 'consumed';
  return token ?? null;
}
