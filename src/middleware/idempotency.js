import crypto from 'crypto';

// In-memory store: storeKey -> { bodyHash, status, body }
// Scoped to: authToken + HTTP method + path + Idempotency-Key
const store = new Map();

function hashBody(body) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(body ?? {}))
    .digest('hex');
}

export function idempotency(req, res, next) {
  if (req.method !== 'POST') {
    return next();
  }

  const key = req.headers['idempotency-key'];

  if (!key) {
    return res.status(400).json({
      type: 'invalid_request',
      code: 'idempotency_key_required',
      message: 'The Idempotency-Key header is required for all POST requests',
    });
  }

  if (key.length > 255) {
    return res.status(400).json({
      type: 'invalid_request',
      code: 'invalid_idempotency_key',
      message: 'Idempotency-Key must not exceed 255 characters',
    });
  }

  const storeKey = `${req.authToken}:POST:${req.path}:${key}`;
  const bodyHash = hashBody(req.body);

  if (store.has(storeKey)) {
    const cached = store.get(storeKey);

    if (cached.bodyHash !== bodyHash) {
      return res.status(422).json({
        type: 'invalid_request',
        code: 'idempotency_conflict',
        message:
          'Idempotency-Key has already been used with a different request body',
      });
    }

    res.set('Idempotency-Key', key);
    res.set('Idempotent-Replayed', 'true');
    return res.status(cached.status).json(cached.body);
  }

  // Wrap res.json so we can cache the first successful response
  const originalJson = res.json;
  res.json = function (body) {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      store.set(storeKey, { bodyHash, status: res.statusCode, body });
    }
    res.set('Idempotency-Key', key);
    return originalJson.call(this, body);
  };

  next();
}
