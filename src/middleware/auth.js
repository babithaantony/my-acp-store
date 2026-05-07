const VALID_TOKENS = new Set(
  (process.env.BEARER_TOKENS || 'sk_test_acp_store_secret')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
);

export function authenticate(req, res, next) {
  const auth = req.headers['authorization'];

  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({
      type: 'unauthorized',
      code: 'missing_authorization',
      message: 'Authorization header with a Bearer token is required',
    });
  }

  const token = auth.slice(7);

  if (!VALID_TOKENS.has(token)) {
    return res.status(401).json({
      type: 'unauthorized',
      code: 'invalid_token',
      message: 'The provided Bearer token is invalid or has been revoked',
    });
  }

  req.authToken = token;
  next();
}
