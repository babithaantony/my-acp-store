import express from 'express';
import { authenticate } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import productsRouter from './routes/products.js';
import checkoutSessionsRouter from './routes/checkoutSessions.js';

const ACP_VERSION = '2026-04-17';

const app = express();

app.use(express.json());

// Stamp every response with the implemented spec version
app.use((_req, res, next) => {
  res.set('API-Version', ACP_VERSION);
  next();
});

// Reject unsupported API-Version headers from clients
app.use((req, res, next) => {
  const requestedVersion = req.headers['api-version'];
  if (requestedVersion && requestedVersion !== ACP_VERSION) {
    return res.status(400).json({
      type: 'invalid_request',
      code: 'unsupported_version',
      message: `API version '${requestedVersion}' is not supported`,
      supported_versions: [ACP_VERSION],
    });
  }
  next();
});

// Bearer token authentication on every route
app.use(authenticate);

app.use('/products', productsRouter);
app.use('/checkout_sessions', checkoutSessionsRouter);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
