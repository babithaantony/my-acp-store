import 'dotenv/config';
import app from './app.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);

app.listen(PORT, () => {
  console.log(`ACP Store listening on http://localhost:${PORT}`);
  console.log(`API Version: 2026-04-17`);
  console.log(`Bearer token(s) loaded: ${process.env.BEARER_TOKENS ? 'yes (from env)' : 'using default test token'}`);
});
