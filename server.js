#!/usr/bin/env node
/**
 * Makiti MCP Server
 * Shopping assistant MCP that uses Hound under the hood for product search,
 * price comparison, deal hunting, and price tracking.
 *
 * Transport: stdio (MCP)
 * Hound: spawned as a child MCP process (JSON-RPC over stdio)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import pino from 'pino';
import { HoundClient } from './hound-client.js';

const logger = pino({ level: 'silent' });
const hound = new HoundClient();

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------
const server = new McpServer(
  {
    name: 'makiti',
    version: '1.0.0',
  },
  {
    capabilities: { tools: {} },
  }
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RETAILER_ALIASES = {
  'amazon.ca': 'amazon canada',
  'bestbuy.ca': 'best buy canada',
  'walmart.ca': 'walmart canada',
  'canadiantire.ca': 'canadian tire',
  'newegg.ca': 'newegg canada',
  'costco.ca': 'costco canada',
  'staples.ca': 'staples canada',
  'thesource.ca': 'the source',
  'homedepot.ca': 'home depot canada',
  'ebay.ca': 'ebay canada',
};

/** Convert a retailer domain into search-friendly words (site: filters kill Hound queries). */
function retailerToWords(retailer) {
  const key = String(retailer || '').toLowerCase().replace(/^www\./, '');
  return RETAILER_ALIASES[key] || key.replace(/\.ca$|\.com$/, '').replace(/\./g, ' ');
}

/** Extract a CAD price from text (handles $22.99, $22,99, $2199, 22.99$, 22,99 $). */
function extractPrice(text) {
  if (!text) return null;
  // $22.99 / $22,99 / $2199 / 22.99$ / 22,99 $
  const m = text.match(/\$\s*(\d{1,4}(?:[.,]\d{1,2})?)/) || text.match(/(\d{1,4}(?:[.,]\d{1,2})?)\s*\$/) || text.match(/(\d{1,4}(?:[.,]\d{1,2})?)\s*(?:CAD|CA\$)/i);
  if (!m) return null;
  const raw = m[1].replace(',', '.');
  const price = parseFloat(raw);
  if (isNaN(price) || price <= 0) return null;
  // Heuristic: prices like 2199 with no decimals are dollars, not cents
  return price;
}

/** Sort comparator: best (cheapest, most relevant) first. */
function sortByBestPrice(a, b) {
  if (a.price !== null && b.price !== null) return a.price - b.price;
  if (a.price !== null) return -1;
  if (b.price !== null) return 1;
  return (b.relevance || 0) - (a.relevance || 0);
}

function extractRetailer(url) {
  try {
    // Accept bare domains too (e.g. "amazon.ca")
    const withProto = /^https?:/.test(url) ? url : `https://${url}`;
    const hostname = new URL(withProto).hostname.replace('www.', '');
    const known = {
      'amazon.ca': 'Amazon Canada', 'amazon.com': 'Amazon',
      'bestbuy.ca': 'Best Buy Canada', 'bestbuy.com': 'Best Buy',
      'walmart.ca': 'Walmart Canada', 'walmart.com': 'Walmart',
      'canadiantire.ca': 'Canadian Tire', 'newegg.ca': 'Newegg Canada',
      'newegg.com': 'Newegg', 'costco.ca': 'Costco Canada', 'costco.com': 'Costco',
      'target.com': 'Target', 'homedepot.ca': 'Home Depot Canada',
      'lows.com': "Lowe's", 'staples.ca': 'Staples Canada',
      'thesource.ca': 'The Source', 'dollarama.com': 'Dollarama',
      'aliexpress.com': 'AliExpress', 'ebay.ca': 'eBay Canada',
    };
    return known[hostname] || hostname;
  } catch {
    return 'Unknown';
  }
}

function detectDealIndicators(text) {
  const keywords = ['sale', 'deal', 'discount', 'promo', 'coupon', 'clearance', 'rabais', 'offre', 'réduction', 'black friday', 'boxing week', 'cyber monday', 'save', 'free shipping', 'livraison gratuite', 'promotion', '% off', 'was $'];
  const lower = text.toLowerCase();
  return keywords.filter(k => lower.includes(k));
}

/** Parallel multi-query search with engine fallback + dedupe. */
async function multiSearch(queries, opts = {}) {
  const settled = await Promise.allSettled(
    queries.map(q => hound.search(q, opts))
  );
  const results = [];
  for (const s of settled) {
    if (s.status === 'fulfilled') results.push(...s.value);
    else logger.error({ err: s.reason?.message }, 'hound search failed');
  }
  // Dedupe by URL
  const seen = new Set();
  const unique = [];
  for (const r of results) {
    if (r.url && !seen.has(r.url)) {
      seen.add(r.url);
      unique.push(r);
    }
  }
  return unique;
}

// ---------------------------------------------------------------------------
// Tool: product_search
// ---------------------------------------------------------------------------
server.tool(
  'product_search',
  'Search for products across the web using shopping-focused queries. Returns product names, prices, retailers, and relevant links.',
  {
    query: z.string().describe('Product name or category to search for (e.g. "iPhone 15", "air fryer under 100")'),
    max_price: z.number().optional().describe('Maximum price in CAD'),
    min_price: z.number().optional().describe('Minimum price in CAD'),
    brand: z.string().optional().describe('Preferred brand (e.g. Apple, Samsung)'),
    retailer: z.string().optional().describe('Specific retailer domain (e.g. amazon.ca, bestbuy.ca)'),
    condition: z.string().optional().describe('Product condition: "new", "used", "refurbished"'),
    limit: z.number().optional().describe('Max number of results to return (default 10)'),
  },
  async ({ query, max_price, min_price, brand, retailer, condition, limit = 10 }) => {
    // Build SHORT queries — long queries with site: filters return zero
    // results across Hound's engines (lesson learned in the wild).
    const words = [query, brand && `${brand}`].filter(Boolean).join(' ');
    const retailerWords = retailer ? retailerToWords(retailer) : null;
    const base = [words, retailerWords].filter(Boolean).join(' ');

    const queries = [
      `${base} price`,
      `${base} buy`,
    ];

    const results = await multiSearch(queries, { max_results: limit, freshness: 'week' });

    // Attach extracted prices + filter by price bounds
    const priced = results.map(r => ({
      rank: 0,
      title: r.title,
      url: r.url,
      snippet: r.snippet,
      retailer: extractRetailer(r.url),
      relevance: r.relevance_score,
      price: extractPrice((r.title || '') + ' ' + (r.snippet || '')),
      deal_indicators: detectDealIndicators((r.title || '') + ' ' + (r.snippet || '')),
    }));

    const filtered = priced.filter(r =>
      (!max_price || r.price === null || r.price <= max_price) &&
      (!min_price || r.price === null || r.price >= min_price)
    );
    filtered.sort(sortByBestPrice);

    const formatted = filtered.slice(0, limit).map((r, i) => ({
      rank: i + 1,
      title: r.title,
      url: r.url,
      snippet: r.snippet,
      retailer: r.retailer,
      price_cad: r.price,
      deal_indicators: r.deal_indicators,
      relevance: r.relevance,
    }));

    const withPrices = formatted.filter(r => r.price_cad !== null);
    const best = withPrices.length > 0 ? withPrices[0] : null;

    const output = {
      query,
      filters: { max_price, min_price, brand, retailer, condition },
      total_results: formatted.length,
      best_price: best
        ? { title: best.title, price_cad: best.price_cad, retailer: best.retailer, url: best.url }
        : null,
      results: formatted,
      notes: [
        'Results are sorted by cheapest price first (when a price was found in the snippet).',
        'Prices are NOT guaranteed — open the links to verify current price, taxes and shipping.',
        'Best Buy Canada blocks automated access; use find_best_price for direct retailer scraping.',
      ],
    };

    return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
  }
);

// ---------------------------------------------------------------------------
// Tool: find_best_price (direct retailer scraping)
// ---------------------------------------------------------------------------
server.tool(
  'find_best_price',
  'Scrape Canadian retailer search pages directly (amazon.ca, walmart.ca, etc.) to find the actual lowest price for a product. More accurate than product_search because it reads live retailer pages. Best Buy Canada blocks automated access.',
  {
    query: z.string().describe('Product to price (e.g. "usb flash drive 128gb", "iphone 15")'),
    retailers: z.array(z.string()).optional().describe('Retailer domains to check (default: ["amazon.ca", "walmart.ca"])'),
    limit: z.number().optional().describe('Max results per retailer to return (default 5)'),
  },
  async ({ query, retailers, limit = 5 }) => {
    const targets = retailers?.length ? retailers : ['amazon.ca', 'walmart.ca'];

    const searchUrls = {
      'amazon.ca': `https://www.amazon.ca/s?k=${encodeURIComponent(query)}`,
      'walmart.ca': `https://www.walmart.ca/en/search?q=${encodeURIComponent(query)}`,
      'bestbuy.ca': `https://www.bestbuy.ca/en-ca/search?path=search&query=${encodeURIComponent(query)}`,
      'canadiantire.ca': `https://www.canadiantire.ca/en/search-results.html?q=${encodeURIComponent(query)}`,
      'staples.ca': `https://www.staples.ca/search?q=${encodeURIComponent(query)}`,
      'newegg.ca': `https://www.newegg.ca/p/pl?d=${encodeURIComponent(query)}`,
    };

    const results = [];
    const errors = [];

    await Promise.all(targets.map(async (retailer) => {
      const url = searchUrls[retailer] || `https://www.${retailer}/search?q=${encodeURIComponent(query)}`;
      try {
        const page = await hound.fetch(url, { max_content_chars: 30000 });
        if (!page?.content_ok) {
          errors.push({ retailer, error: `fetch blocked (${page?.status || 'unknown'})` });
          return;
        }
        const text = Array.isArray(page.content) ? page.content.join('\n') : String(page.content || '');
        const items = parseRetailerResults(text, retailer);
        for (const it of items) {
          it.retailer = extractRetailer(retailer);
          it.retailer_domain = retailer;
          results.push(it);
        }
        if (items.length === 0) {
          errors.push({ retailer, error: 'no priceable items parsed from page' });
        }
      } catch (err) {
        errors.push({ retailer, error: err.message });
      }
    }));

    results.sort(sortByBestPrice);
    const top = results.slice(0, limit);

    const output = {
      query,
      retailers_checked: targets,
      best_price: top.length > 0
        ? { title: top[0].title, price_cad: top[0].price, retailer: top[0].retailer, url: top[0].url }
        : null,
      results: top,
      errors,
      notes: [
        'Prices are live from retailer search pages at fetch time.',
        'Best Buy Canada (403) and other bot-protected sites may fail — errors are listed above.',
        'Verify price on the product page before buying (taxes/shipping not included).',
      ],
    };

    return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
  }
);

/** Parse retailer search-page text into {title, price} items.
 *  Strategy:
 *  - "Now $X.XX" / "current price $X.XX" / "$X.XX" → reliable price sources
 *  - Lines containing "You save $X" NEVER provide the price (it's a discount note)
 *  - Skip nav lines, markdown headers, "More buying choices", "List:", "You pay"
 */
function parseRetailerResults(text, retailer) {
  const items = [];
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Never take a price from discount-savings lines
    if (/\byou save\s+\$/i.test(line)) continue;
    // Skip noise lines
    if (/^(you save|save|was|reduced|list:|list price|reg\.?|regular|up to|skip|results for|main content|more buying|you pay|##)/i.test(line)) continue;
    if (/^(results|sort|filter|page|previous|next|sponsored|showing|delivering to|search amazon|hello|account|cart)\b/i.test(line)) continue;

    // Extract a price with decimals (or clean 2-3 digit dollar amount)
    const m = line.match(/\$\s*(\d{1,4}(?:[.,]\d{2})?)/) || line.match(/(\d{1,4}(?:[.,]\d{2})?)\s*CAD/i);
    if (!m) continue;
    const raw = m[1].replace(',', '.');
    const price = parseFloat(raw);
    if (isNaN(price) || price <= 0) continue;

    // Find the title: nearest previous line that looks like a product name
    const title = findTitle(lines, i);
    if (!title || title.length < 4) continue;
    if (/^(results for|usb \d|results|sort|filter|page|skip|main content|delivering to|search amazon|more buying)/i.test(title)) continue;

    // Clean title: cut off review noise + discount notes glued to the name
    const cleanTitle = title
      .replace(/You save.*$/i, '')
      .replace(/\d+(?:[.,]\d+)? out of 5 stars?.*$/i, '')
      .replace(/\d+ reviews?.*$/i, '')
      .replace(/Delivery,.*$/i, '')
      .replace(/\s{2,}/g, ' ')
      .trim();

    // Dedupe by clean title
    if (items.some(it => it.title === cleanTitle)) continue;
    items.push({ title: cleanTitle.slice(0, 120), price, snippet: line.slice(0, 120) });
  }

  return items.slice(0, 25);
}

function findTitle(lines, priceIdx) {
  // Look further back (Amazon puts "Price, product page" right before the price,
  // with the real name several lines above that).
  for (let i = priceIdx - 1; i >= Math.max(0, priceIdx - 9); i--) {
    const t = lines[i];
    if (/^(skip|results|filter|sort|search|account|cart|hello|deals|delivery|pickup|free|save|sponsored|current|was|you save|you pay|reduced|now|out of|reviews?|stars|up to|##|showing|page|previous|next|price|options|more buying|list:|add to cart)/i.test(t)) continue;
    if (/^\(\d+(?:[.,]\d+)?k?\)/i.test(t)) continue;                     // "(65.3K)"
    if (/^\d+\+ bought in past month/i.test(t)) continue;                // "500+ bought in past month"
    if (/^\d+ sizes?$/i.test(t)) continue;                               // "2 sizes", "4 sizes"
    if (/^(tomorrow|today|sunday|monday|tuesday|wednesday|thursday|friday|saturday),/i.test(t)) continue; // "Tomorrow, Aug 1"
    if (/^\d+(?:[.,]\d+)? out of 5 stars?/i.test(t)) continue;          // "4.4 out of 5 stars"
    if (/^(amazon's choice|bestseller|highly rated|sponsored|or fastest|free delivery|free pickup)/i.test(t)) continue;
    if (t.length > 5 && t.length < 200 && !/^\$/.test(t)) return t;
  }
  return null;
}


server.tool(
  'product_compare',
  'Compare two products side-by-side: specs, prices, pros/cons, and verdict.',
  {
    product_a: z.string().describe('First product name/model (e.g. "iPhone 15")'),
    product_b: z.string().describe('Second product name/model (e.g. "Samsung S24")'),
    category: z.string().optional().describe('Product category for context (e.g. smartphone, laptop)'),
    budget: z.number().optional().describe('Budget in CAD to prioritize value'),
  },
  async ({ product_a, product_b, category, budget }) => {
    const queries = [
      `${product_a} vs ${product_b} comparison review ${category || ''}`,
      `${product_a} price CAD Canada`,
      `${product_b} price CAD Canada`,
    ];

    const results = await multiSearch(queries, { max_results: 8, freshness: 'month' });

    const matchA = (r) => (r.title + ' ' + (r.snippet || '')).toLowerCase().includes(product_a.toLowerCase());
    const matchB = (r) => (r.title + ' ' + (r.snippet || '')).toLowerCase().includes(product_b.toLowerCase());

    const output = {
      product_a,
      product_b,
      category,
      budget,
      sources_found: results.length,
      comparison: {
        product_a: {
          name: product_a,
          evidence: results.filter(matchA).slice(0, 5).map(r => ({ title: r.title, url: r.url, snippet: r.snippet })),
        },
        product_b: {
          name: product_b,
          evidence: results.filter(matchB).slice(0, 5).map(r => ({ title: r.title, url: r.url, snippet: r.snippet })),
        },
      },
      verdict: generateVerdict(results, product_a, product_b, budget),
      sources: results.slice(0, 10).map(r => ({ title: r.title, url: r.url, retailer: extractRetailer(r.url) })),
    };

    return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
  }
);

// ---------------------------------------------------------------------------
// Tool: find_deals
// ---------------------------------------------------------------------------
server.tool(
  'find_deals',
  'Hunt for active deals, promo codes, and discounts for a product or category.',
  {
    query: z.string().describe('Product, brand, or category to find deals for (e.g. "Nike shoes", "mechanical keyboard")'),
    region: z.string().optional().describe('Geographic region for deals (default: Canada)'),
    retailer: z.string().optional().describe('Focus on specific retailer (e.g. amazon.ca)'),
    limit: z.number().optional().describe('Max deals to return (default 10)'),
  },
  async ({ query, region = 'Canada', retailer, limit = 10 }) => {
    // Keep queries SHORT (long ones return zero results) + scope to CA.
    const regionWord = region.toLowerCase() === 'canada' ? 'canada' : region;
    const retailerWords = retailer ? retailerToWords(retailer) : null;
    const base = [query, retailerWords].filter(Boolean).join(' ');

    const queries = [
      `${base} deal ${regionWord}`,
      `${base} coupon`,
      `${base} rabais`,
    ];

    const results = await multiSearch(queries, { max_results: limit, freshness: 'day' });

    // Region filter: keep CA-related results, drop obviously foreign hits
    // (lesson: raw "deals" searches surface hotukdeals, Pakistani shops, etc.)
    const CA_HINTS = /canada|\.ca|cad|québec|quebec|montreal|toronto|ontario|bc |british columbia|alberta|redflagdeals|slickdeals|bestbuy|walmart canada|amazon canada/i;
    const FOREIGN_HINTS = /hotukdeals|\.co\.uk|\.de\b|pakistan|karachi|\.com\.au|indiamart|aliexpress|banggood/i;

    const deals = results
      .filter(r => {
        const text = (r.title || '') + ' ' + (r.snippet || '') + ' ' + (r.url || '');
        if (FOREIGN_HINTS.test(text) && !CA_HINTS.test(text)) return false;
        return true;
      })
      .slice(0, limit)
      .map((r, i) => ({
        rank: i + 1,
        title: r.title,
        url: r.url,
        snippet: r.snippet,
        retailer: extractRetailer(r.url),
        price_cad: extractPrice((r.title || '') + ' ' + (r.snippet || '')),
        deal_indicators: detectDealIndicators((r.title || '') + ' ' + (r.snippet || '')),
      }));

    const output = {
      query,
      region,
      retailer_focus: retailer,
      total_deals_found: deals.length,
      deals,
      strategy: [
        'Check coupon sites like RedFlagDeals, Save.ca, CouponFollow for promo codes.',
        'Price-match policies at Best Buy Canada and Visions can save extra.',
        'Black Friday / Boxing Week often yields deepest discounts.',
        'Use cashback portals (Rakuten, TopCashback) for extra savings.',
      ],
    };

    return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
  }
);

// ---------------------------------------------------------------------------
// Tool: price_history
// ---------------------------------------------------------------------------
server.tool(
  'price_history',
  'Track or estimate price history for a product to determine if current price is a good deal.',
  {
    product: z.string().describe('Product name/model (e.g. "PlayStation 5")'),
    retailers: z.array(z.string()).optional().describe('List of retailer domains to track (default: major CA retailers)'),
    days_back: z.number().optional().describe('How many days of history to estimate (default 90)'),
  },
  async ({ product, retailers, days_back = 90 }) => {
    const retailersList = retailers || ['amazon.ca', 'bestbuy.ca', 'walmart.ca', 'canadiantire.ca', 'newegg.ca'];
    const queries = [
      `${product} price Canada`,
      `${product} ${retailersList.slice(0, 3).map(s => `site:${s}`).join(' OR ')}`,
      `${product} price history tracking`,
    ];

    const results = await multiSearch(queries, { max_results: 10, freshness: 'month' });

    const output = {
      product,
      retailers: retailersList,
      period_days: days_back,
      current_listings: results.slice(0, 10).map(r => ({
        title: r.title,
        url: r.url,
        snippet: r.snippet,
        retailer: extractRetailer(r.url),
        relevance: r.relevance_score,
      })),
      price_tracking_tips: [
        'Install CamelCamelCamel browser extension for Amazon price history.',
        'Use PriceSpy or Google Shopping for cross-retailer tracking.',
        'Set price alerts on deal forums like RedFlagDeals.',
        'Many retailers price-match — check policy before buying.',
      ],
      assessment: 'Use the listings above plus smart_fetch on the links for exact current prices. Compare against known MSRP to judge deal quality.',
    };

    return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
  }
);

// ---------------------------------------------------------------------------
// Tool: makiti_guide
// ---------------------------------------------------------------------------
server.tool(
  'makiti_guide',
  'Get guidance on how to use Makiti tools effectively for shopping decisions.',
  {
    scenario: z.string().optional().describe('Shopping scenario (e.g. "buying a laptop", "gift under 50")'),
  },
  async ({ scenario }) => {
    const guide = {
      overview: 'Makiti uses Hound (web search + fetch) to find real product data across Canadian and international retailers.',
      workflow: {
        step_1: 'Use find_best_price to scrape live prices from Amazon.ca and Walmart.ca (most accurate).',
        step_2: 'Use product_search with filters (price, brand, retailer) to find more candidates.',
        step_3: 'Use product_compare to weigh two top options side-by-side.',
        step_4: 'Use find_deals to hunt active promotions and promo codes.',
        step_5: 'Use price_history to confirm the current price is actually a good deal.',
      },
      pro_tips: [
        'Always verify prices directly on retailer sites — search results may be stale.',
        'Factor in shipping costs, taxes, and warranty when comparing.',
        'Check return policies and price-match guarantees.',
        'For high-value items, look for open-box or refurbished deals from certified sellers.',
        'Use cashback portals (Rakuten, TopCashback) for extra savings on eligible purchases.',
      ],
      scenario_specific: scenario
        ? `For "${scenario}": Start with product_search, filter by your budget, then product_compare your top 2 picks before hunting deals.`
        : null,
    };

    return { content: [{ type: 'text', text: JSON.stringify(guide, null, 2) }] };
  }
);

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

function generateVerdict(results, productA, productB, budget) {
  const aResults = results.filter(r => (r.title + ' ' + (r.snippet || '')).toLowerCase().includes(productA.toLowerCase()));
  const bResults = results.filter(r => (r.title + ' ' + (r.snippet || '')).toLowerCase().includes(productB.toLowerCase()));

  let verdict = '';
  if (aResults.length > bResults.length) {
    verdict = `${productA} appears to have more coverage/reviews available. More data = better informed decision.`;
  } else if (bResults.length > aResults.length) {
    verdict = `${productB} has more recent coverage. Consider if that translates to better availability.`;
  } else {
    verdict = 'Both products have similar web presence. Use product-specific criteria (budget, features, warranty) to decide.';
  }

  if (budget) {
    verdict += ` | Budget: $${budget} CAD — filter both options with product_search max_price:${budget} before comparing.`;
  }

  return verdict;
}

// ---------------------------------------------------------------------------
// Start server (hound connects lazily on first tool call)
// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
logger.info('Makiti MCP server running on stdio (hound lazy-connect)');
