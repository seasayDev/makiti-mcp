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

function extractRetailer(url) {
  try {
    const hostname = new URL(url).hostname.replace('www.', '');
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
  const keywords = ['sale', 'deal', 'discount', 'promo', 'coupon', 'clearance', 'rabais', 'offre', 'réduction', 'black friday', 'boxing week', 'cyber monday', 'save', 'free shipping', 'livraison gratuite', 'promotion'];
  const lower = text.toLowerCase();
  return keywords.filter(k => lower.includes(k));
}

async function multiSearch(queries, opts = {}) {
  const results = [];
  for (const q of queries) {
    try {
      const res = await hound.search(q, opts);
      results.push(...res);
    } catch (err) {
      logger.error({ err: err.message, q }, 'hound search failed');
    }
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
    const parts = [query];
    if (brand) parts.push(`${brand}`);
    if (retailer) parts.push(`site:${retailer}`);
    if (condition) parts.push(condition);
    if (min_price) parts.push(`$${min_price}+`);
    if (max_price) parts.push(`under $${max_price}`);
    const base = parts.join(' ');

    const queries = [
      `${base} price Canada`,
      `${base} buy online`,
    ];

    const results = await multiSearch(queries, { max_results: limit, freshness: 'week' });

    const formatted = results.slice(0, limit).map((r, i) => ({
      rank: i + 1,
      title: r.title,
      url: r.url,
      snippet: r.snippet,
      retailer: extractRetailer(r.url),
      relevance: r.relevance_score,
    }));

    const output = {
      query,
      filters: { max_price, min_price, brand, retailer, condition },
      total_results: formatted.length,
      results: formatted,
      tips: [
        'Prices are NOT guaranteed — open the links to verify current price, taxes and shipping.',
        'Use product_compare to compare two items side-by-side.',
        'Use find_deals to hunt promotions on this product.',
      ],
    };

    return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
  }
);

// ---------------------------------------------------------------------------
// Tool: product_compare
// ---------------------------------------------------------------------------
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
    const queries = [
      `${query} deals ${region}`,
      `${query} promo coupon discount`,
      `${query} rabais promotion Québec`,
    ];
    if (retailer) queries.push(`${query} deals site:${retailer}`);

    const results = await multiSearch(queries, { max_results: limit, freshness: 'day' });

    const deals = results.slice(0, limit).map((r, i) => ({
      rank: i + 1,
      title: r.title,
      url: r.url,
      snippet: r.snippet,
      retailer: extractRetailer(r.url),
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
        step_1: 'Use product_search with filters (price, brand, retailer) to find candidates.',
        step_2: 'Use product_compare to weigh two top options side-by-side.',
        step_3: 'Use find_deals to hunt active promotions and promo codes.',
        step_4: 'Use price_history to confirm the current price is actually a good deal.',
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
