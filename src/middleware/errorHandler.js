export function notFoundHandler(req, res) {
  res.status(404).json({
    type: 'invalid_request',
    code: 'not_found',
    message: `Route not found: ${req.method} ${req.path}`,
  });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  console.error('[Unhandled Error]', err);

  const status = err.status || err.statusCode || 500;
  const type = status >= 500 ? 'processing_error' : 'invalid_request';

  res.status(status).json({
    type,
    code: err.code || 'internal_error',
    message: err.message || 'An unexpected error occurred',
  });
}
