#!/usr/bin/env node
/**
 * Makiti MCP Server
 * Shopping assistant MCP that uses Hound under the hood for product search,
 * price comparison, deal hunting, and price tracking.
 *
 * Transport: stdio
 * Protocol: MCP (Model Context Protocol)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import pino from 'pino';

const logger = pino({ level: 'silent' });

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------
const server = new McpServer(
  {
    name: 'makiti',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a Google Shopping-style search query.
 */
function buildShoppingQuery(baseQuery, options = {}) {
  const { maxPrice, minPrice, brand, site, condition } = options;
  const parts = [baseQuery];
  if (brand) parts.push(`site:${brand.toLowerCase()}.com OR ${brand}`);
  if (site) parts.push(`site:${site}`);
  if (condition) parts.push(condition);
  return parts.join(' ');
}

/**
 * Build a price-tracking query across multiple retailers.
 */
function buildPriceTrackingQuery(product, retailers = []) {
  const sites = retailers.length > 0 ? retailers : ['amazon.com', 'bestbuy.com', 'walmart.com', 'newegg.com', 'canadiantire.ca'];
  const siteFilters = sites.map(s => `site:${s}`).join(' OR ');
  return `${product} price ${siteFilters}`;
}

/**
 * Build a deal-hunting query.
 */
function buildDealsQuery(category, region = 'Canada') {
  const queries = [
    `${category} deals ${region}`,
    `${category} promo ${region}`,
    `${category} rabais Québec Canada`,
  ];
  return queries;
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
    const shoppingQuery = buildShoppingQuery(query, { maxPrice: max_price, minPrice: min_price, brand, site: retailer, condition });

    const houndQueries = [
      `${shoppingQuery} price CAD Canada`,
      `${shoppingQuery} buy online`,
    ];

    const results = [];
    for (const q of houndQueries) {
      try {
        const resp = await fetch('http://localhost:8001/v1/tools/mcp__hound__mcp_smart_search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: Date.now() + Math.random(),
            method: 'tools/call',
            params: {
              name: 'mcp__hound__mcp_smart_search',
              arguments: {
                query: q,
                options: {
                  max_results: limit,
                  freshness: 'week',
                  engines: ['google', 'brave', 'ddg', 'yahoo'],
                },
              },
            },
          }),
        });
        if (!resp.ok) continue;
        const data = await resp.json();
        if (data.result?.content) {
          for (const block of data.result.content) {
            if (block.type === 'text') {
              try {
                const parsed = JSON.parse(block.text);
                if (parsed.data?.web) results.push(...parsed.data.web);
              } catch {
                // skip non-json blocks
              }
            }
          }
        }
      } catch (err) {
        logger.error({ err: err.message }, 'search query failed');
      }
    }

    // Deduplicate by URL
    const seen = new Set();
    const unique = [];
    for (const r of results) {
      const key = r.url;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(r);
      }
    }

    const formatted = unique.slice(0, limit).map((r, i) => ({
      rank: i + 1,
      title: r.title,
      url: r.url,
      snippet: r.description,
      retailer: extractRetailer(r.url),
    }));

    const output = {
      query,
      filters: { max_price, min_price, brand, retailer, condition },
      total_results: formatted.length,
      results: formatted,
      tips: [
        'Click links to verify current prices — listings may have changed.',
        'Use product_compare to side-by-side two items.',
        'Use find_deals to hunt for promotions.',
      ],
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
    };
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
      `${product_a} vs ${product_b} specs review`,
      `${product_a} price CAD`,
      `${product_b} price CAD`,
      `${product_a} ${product_b} comparison ${category || ''}`,
    ];

    const allResults = [];
    for (const q of queries) {
      try {
        const resp = await fetch('http://localhost:8001/v1/tools/mcp__hound__mcp_smart_search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: Date.now() + Math.random(),
            method: 'tools/call',
            params: {
              name: 'mcp__hound__mcp_smart_search',
              arguments: {
                query: q,
                options: { max_results: 8, freshness: 'month', engines: ['google', 'brave', 'ddg'] },
              },
            },
          }),
        });
        if (!resp.ok) continue;
        const data = await resp.json();
        if (data.result?.content) {
          for (const block of data.result.content) {
            if (block.type === 'text') {
              try {
                const parsed = JSON.parse(block.text);
                if (parsed.data?.web) allResults.push(...parsed.data.web);
              } catch { /* skip */ }
            }
          }
        }
      } catch (err) {
        logger.error({ err: err.message }, 'compare query failed');
      }
    }

    const seen = new Set();
    const unique = [];
    for (const r of allResults) {
      if (!seen.has(r.url)) { seen.add(r.url); unique.push(r); }
    }

    const output = {
      product_a,
      product_b,
      category,
      budget,
      sources_found: unique.length,
      comparison: {
        product_a: { name: product_a, evidence: unique.filter(r => r.title.toLowerCase().includes(product_a.toLowerCase()) || r.description.toLowerCase().includes(product_a.toLowerCase())).slice(0, 5).map(r => ({ title: r.title, url: r.url, snippet: r.description })) },
        product_b: { name: product_b, evidence: unique.filter(r => r.title.toLowerCase().includes(product_b.toLowerCase()) || r.description.toLowerCase().includes(product_b.toLowerCase())).slice(0, 5).map(r => ({ title: r.title, url: r.url, snippet: r.description })) },
      },
      verdict: generateVerdict(unique, product_a, product_b, budget),
      sources: unique.slice(0, 10).map(r => ({ title: r.title, url: r.url })),
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
    const dealQueries = buildDealsQuery(query, region);
    if (retailer) dealQueries.push(`${query} deals site:${retailer}`);

    const allResults = [];
    for (const q of dealQueries) {
      try {
        const resp = await fetch('http://localhost:8001/v1/tools/mcp__hound__mcp_smart_search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: Date.now() + Math.random(),
            method: 'tools/call',
            params: {
              name: 'mcp__hound__mcp_smart_search',
              arguments: {
                query: q,
                options: { max_results: limit, freshness: 'day', engines: ['google', 'brave', 'ddg', 'yahoo'] },
              },
            },
          }),
        });
        if (!resp.ok) continue;
        const data = await resp.json();
        if (data.result?.content) {
          for (const block of data.result.content) {
            if (block.type === 'text') {
              try {
                const parsed = JSON.parse(block.text);
                if (parsed.data?.web) allResults.push(...parsed.data.web);
              } catch { /* skip */ }
            }
          }
        }
      } catch (err) {
        logger.error({ err: err.message }, 'deal search failed');
      }
    }

    const seen = new Set();
    const unique = [];
    for (const r of allResults) {
      if (!seen.has(r.url)) { seen.add(r.url); unique.push(r); }
    }

    // Detect promo indicators
    const deals = unique.slice(0, limit).map((r, i) => ({
      rank: i + 1,
      title: r.title,
      url: r.url,
      snippet: r.description,
      retailer: extractRetailer(r.url),
      deal_indicators: detectDealIndicators(r.title + ' ' + r.description),
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
        'Use browser extensions like Honey or Rakuten for cashback.',
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
    const query = buildPriceTrackingQuery(product, retailers);
    try {
      const resp = await fetch('http://localhost:8001/v1/tools/mcp__hound__mcp_smart_search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now() + Math.random(),
          method: 'tools/call',
          params: {
            name: 'mcp__hound__mcp_smart_search',
            arguments: {
              query: `${query} price history`,
              options: { max_results: 10, freshness: 'month', engines: ['google', 'brave'] },
            },
          },
          }),
        });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      let results = [];
      if (data.result?.content) {
        for (const block of data.result.content) {
          if (block.type === 'text') {
            try { results.push(...JSON.parse(block.text).data.web); } catch { /* skip */ }
          }
        }
      }

      const seen = new Set();
      const unique = results.filter(r => { if (seen.has(r.url)) return false; seen.add(r.url); return true; });

      const output = {
        product,
        retailers: retailers || ['amazon.ca', 'bestbuy.ca', 'walmart.ca', 'canadiantire.ca', 'newegg.ca'],
        period_days: days_back,
        price_tracking_tips: [
          'Install CamelCamelCamel browser extension for Amazon price history.',
          'Use PriceSpy or Google Shopping for cross-retailer tracking.',
          'Set price alerts on deal forums like RedFlagDeals.',
          'Many retailers price-match — check policy before buying.',
        ],
        current_listings: unique.slice(0, 10).map(r => ({ title: r.title, url: r.url, snippet: r.description, retailer: extractRetailer(r.url) })),
        assessment: 'Use the listings above plus browser tools for exact current prices. Compare against known MSRP to judge deal quality.',
      };

      return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: err.message, product, tip: 'Check Hound server is running on :8001' }, null, 2) }] };
    }
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
      overview: 'Makiti uses Hound web search to find real product data across Canadian and international retailers.',
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

function extractRetailer(url) {
  try {
    const hostname = new URL(url).hostname.replace('www.', '');
    const known = {
      'amazon.ca': 'Amazon Canada',
      'amazon.com': 'Amazon',
      'bestbuy.ca': 'Best Buy Canada',
      'bestbuy.com': 'Best Buy',
      'walmart.ca': 'Walmart Canada',
      'walmart.com': 'Walmart',
      'canadiantire.ca': 'Canadian Tire',
      'newegg.ca': 'Newegg Canada',
      'newegg.com': 'Newegg',
      'costco.ca': 'Costco Canada',
      'costco.com': 'Costco',
      'target.com': 'Target',
      'homedepot.ca': 'Home Depot Canada',
      'lowe\'s.com': "Lowe's",
    };
    return known[hostname] || hostname;
  } catch {
    return 'Unknown';
  }
}

function detectDealIndicators(text) {
  const keywords = ['sale', 'deal', 'discount', 'promo', 'coupon', 'clearance', 'rabais', 'offre', 'réduction', 'black friday', 'boxing week', 'cyber monday', 'save', 'free shipping'];
  const lower = text.toLowerCase();
  return keywords.filter(k => lower.includes(k));
}

function generateVerdict(results, productA, productB, budget) {
  const aResults = results.filter(r => r.title.toLowerCase().includes(productA.toLowerCase()) || r.description.toLowerCase().includes(productA.toLowerCase()));
  const bResults = results.filter(r => r.title.toLowerCase().includes(productB.toLowerCase()) || r.description.toLowerCase().includes(productB.toLowerCase()));

  let verdict = '';
  if (aResults.length > bResults.length) {
    verdict = `${productA} appears to have more coverage/reviews available. More data = better informed decision.`;
  } else if (bResults.length > aResults.length) {
    verdict = `${productB} has more recent coverage. Consider if that translates to better availability.`;
  } else {
    verdict = `Both products have similar web presence. Use product-specific criteria (budget, features, warranty) to decide.`;
  }

  if (budget) {
    verdict += ` | Budget: $${budget} CAD — filter both options with product_search max_price:${budget} before comparing.`;
  }

  return verdict;
}

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
logger.info('Makiti MCP server running on stdio');
