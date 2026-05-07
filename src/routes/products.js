import { Router } from 'express';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(
  readFileSync(join(__dirname, '../data/products.json'), 'utf-8')
);

const router = Router();

/**
 * GET /products
 *
 * Returns the product feed. Supports:
 *   ?category=Electronics   filter by variant category name (case-insensitive)
 *   ?available=true|false   filter by availability
 *   ?limit=50               max items to return (1-100, default 50)
 *   ?starting_after=prod_x  cursor-based pagination (product ID)
 */
router.get('/', (req, res) => {
  const { limit, starting_after, category, available } = req.query;

  let results = [...catalog];

  if (category) {
    const q = category.toLowerCase();
    results = results.filter((p) =>
      p.variants.some((v) =>
        v.categories?.some((c) => c.name.toLowerCase() === q)
      )
    );
  }

  if (available !== undefined) {
    const wantAvailable = available === 'true';
    results = results.filter((p) =>
      p.variants.some((v) => v.availability?.available === wantAvailable)
    );
  }

  if (starting_after) {
    const idx = results.findIndex((p) => p.id === starting_after);
    if (idx === -1) {
      return res.status(422).json({
        type: 'invalid_request',
        code: 'invalid_cursor',
        message: `Product '${starting_after}' not found; cannot use as pagination cursor`,
        param: '$.starting_after',
      });
    }
    results = results.slice(idx + 1);
  }

  const pageSize = Math.min(Math.max(parseInt(limit) || 50, 1), 100);
  const page = results.slice(0, pageSize);
  const hasMore = results.length > pageSize;

  res.json({
    products: page,
    has_more: hasMore,
    ...(hasMore && { next_starting_after: page[page.length - 1].id }),
    total_count: catalog.length,
  });
});

export default router;
