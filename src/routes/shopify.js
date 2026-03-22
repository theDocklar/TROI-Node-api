const express = require('express');
const crypto = require('crypto');
const fetch = require('node-fetch');
const authMiddleware = require('../middleware/auth');
const Shop = require('../models/Shop');

const router = express.Router();

// In-memory OAuth state store (per-process; fine for dev)
// key: userId string, value: { state, expiresAt }
const pendingStates = new Map();

function cleanExpiredStates() {
  const now = Date.now();
  for (const [key, val] of pendingStates.entries()) {
    if (val.expiresAt < now) pendingStates.delete(key);
  }
}

function shopifyRequest(shopDomain, accessToken, path) {
  return fetch(`https://${shopDomain}/admin/api/2024-01${path}`, {
    headers: { 'X-Shopify-Access-Token': accessToken },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/shopify/connect?shop=my-store.myshopify.com
// Returns the Shopify OAuth URL for the frontend to redirect to
// ─────────────────────────────────────────────────────────────────────────────
router.get('/connect', authMiddleware, (req, res) => {
  const { shop } = req.query;

  if (!shop || !/^[a-zA-Z0-9-]+\.myshopify\.com$/i.test(shop)) {
    return res.status(400).json({ message: 'Invalid shop domain. Use format: your-store.myshopify.com' });
  }

  cleanExpiredStates();

  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(req.user.id, { state, expiresAt: Date.now() + 10 * 60 * 1000 });

  const params = new URLSearchParams({
    client_id: process.env.SHOPIFY_CLIENT_ID,
    scope: process.env.SHOPIFY_SCOPES,
    redirect_uri: process.env.SHOPIFY_REDIRECT_URI,
    state,
  });

  const url = `https://${shop}/admin/oauth/authorize?${params.toString()}`;
  res.json({ url });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/shopify/callback
// Body: all params Shopify sent in the redirect URL (shop, code, hmac, state, timestamp, host, etc.)
// Verifies HMAC + state, exchanges code for access token, stores Shop doc
// ─────────────────────────────────────────────────────────────────────────────
router.post('/callback', authMiddleware, async (req, res) => {
  try {
    const { shop, code, hmac, state, timestamp } = req.body;

    if (!shop || !code || !hmac || !state) {
      return res.status(400).json({ message: 'Missing required OAuth params' });
    }

    // Verify state
    cleanExpiredStates();
    const stored = pendingStates.get(req.user.id);
    if (!stored) {
      return res.status(400).json({ message: 'OAuth state expired or not found. Please try connecting again.' });
    }
    pendingStates.delete(req.user.id);

    const storedStateBuf = Buffer.from(stored.state, 'utf8');
    const receivedStateBuf = Buffer.from(state, 'utf8');
    if (
      storedStateBuf.length !== receivedStateBuf.length ||
      !crypto.timingSafeEqual(storedStateBuf, receivedStateBuf)
    ) {
      return res.status(400).json({ message: 'Invalid OAuth state' });
    }

    // Verify timestamp if present (must be within 10 minutes)
    if (timestamp && Date.now() / 1000 - parseInt(timestamp) > 600) {
      return res.status(400).json({ message: 'OAuth request expired' });
    }

    // Verify HMAC
    const params = Object.entries(req.body)
      .filter(([key]) => key !== 'hmac')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');

    const digest = crypto
      .createHmac('sha256', process.env.SHOPIFY_CLIENT_SECRET)
      .update(params)
      .digest('hex');

    const digestBuf = Buffer.from(digest, 'utf8');
    const hmacBuf = Buffer.from(hmac, 'utf8');
    if (
      digestBuf.length !== hmacBuf.length ||
      !crypto.timingSafeEqual(digestBuf, hmacBuf)
    ) {
      return res.status(400).json({ message: 'HMAC verification failed' });
    }

    // Exchange code for access token
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.SHOPIFY_CLIENT_ID,
        client_secret: process.env.SHOPIFY_CLIENT_SECRET,
        code,
      }),
    });

    if (!tokenRes.ok) {
      return res.status(502).json({ message: 'Failed to exchange OAuth code for access token' });
    }

    const { access_token: accessToken } = await tokenRes.json();

    // Fetch shop info
    const shopRes = await shopifyRequest(shop, accessToken, '/shop.json');
    let shopName = shop;
    let currency = 'USD';
    let plan = '';

    if (shopRes.ok) {
      const shopData = await shopRes.json();
      shopName = shopData.shop?.name ?? shop;
      currency = shopData.shop?.currency ?? 'USD';
      plan = shopData.shop?.plan_name ?? '';
    }

    // Upsert Shop document
    const shopDoc = await Shop.findOneAndUpdate(
      { userId: req.user.id, shopDomain: shop.toLowerCase() },
      { accessToken, shopName, currency, plan, installedAt: new Date() },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.json({
      shop: {
        domain: shopDoc.shopDomain,
        shopName: shopDoc.shopName,
        currency: shopDoc.currency,
        plan: shopDoc.plan,
      },
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/shopify/status
// Returns whether the user has a connected Shopify store
// ─────────────────────────────────────────────────────────────────────────────
router.get('/status', authMiddleware, async (req, res) => {
  try {
    const shopDoc = await Shop.findOne({ userId: req.user.id });
    if (!shopDoc) return res.json({ connected: false });

    res.json({
      connected: true,
      shop: {
        domain: shopDoc.shopDomain,
        shopName: shopDoc.shopName,
        currency: shopDoc.currency,
        plan: shopDoc.plan,
      },
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/shopify/orders?days=60
// Returns daily revenue, order counts, and refund rate for the last N days
// ─────────────────────────────────────────────────────────────────────────────
router.get('/orders', authMiddleware, async (req, res) => {
  try {
    const shopDoc = await Shop.findOne({ userId: req.user.id });
    if (!shopDoc) return res.status(404).json({ message: 'No Shopify store connected' });

    const days = Math.min(parseInt(req.query.days ?? '60') || 60, 90);
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    startDate.setUTCHours(0, 0, 0, 0);

    // Paginate Shopify Orders API
    const allOrders = [];
    let url = `https://${shopDoc.shopDomain}/admin/api/2024-01/orders.json?status=any&created_at_min=${startDate.toISOString()}&limit=250&fields=id,created_at,total_price,financial_status,refunds`;

    while (url) {
      const response = await fetch(url, {
        headers: { 'X-Shopify-Access-Token': shopDoc.accessToken },
      });

      if (!response.ok) {
        return res.status(502).json({ message: `Shopify API error: ${response.status}` });
      }

      const data = await response.json();
      allOrders.push(...(data.orders ?? []));

      // Follow pagination via Link header
      const linkHeader = response.headers.get('link');
      const nextMatch = linkHeader?.match(/<([^>]+)>;\s*rel="next"/);
      url = nextMatch ? nextMatch[1] : null;
    }

    // Build day-indexed arrays (index 0 = startDate, index days-1 = today)
    const dailyRevenue = new Array(days).fill(0);
    const dailyOrders = new Array(days).fill(0);
    const dailyRefundAmount = new Array(days).fill(0);

    for (const order of allOrders) {
      const orderDate = new Date(order.created_at);
      orderDate.setUTCHours(0, 0, 0, 0);
      const dayIndex = Math.floor((orderDate - startDate) / (24 * 60 * 60 * 1000));

      if (dayIndex < 0 || dayIndex >= days) continue;

      dailyRevenue[dayIndex] += parseFloat(order.total_price ?? '0');
      dailyOrders[dayIndex] += 1;

      // Sum refund amounts
      if (order.refunds?.length) {
        for (const refund of order.refunds) {
          for (const txn of refund.transactions ?? []) {
            dailyRefundAmount[dayIndex] += parseFloat(txn.amount ?? '0');
          }
        }
      }
    }

    const totalRevenue = dailyRevenue.reduce((a, b) => a + b, 0);
    const totalRefunds = dailyRefundAmount.reduce((a, b) => a + b, 0);
    const refundRate = totalRevenue > 0 ? totalRefunds / totalRevenue : 0;

    // Update last synced timestamp
    shopDoc.lastSyncedAt = new Date();
    await shopDoc.save();

    res.json({ dailyRevenue, dailyOrders, dailyRefundAmount, refundRate, days });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/shopify/products
// Returns the store's product catalog
// ─────────────────────────────────────────────────────────────────────────────
router.get('/products', authMiddleware, async (req, res) => {
  try {
    const shopDoc = await Shop.findOne({ userId: req.user.id });
    if (!shopDoc) return res.status(404).json({ message: 'No Shopify store connected' });

    const allProducts = [];
    let url = `https://${shopDoc.shopDomain}/admin/api/2024-01/products.json?limit=250&fields=id,title,variants,product_type`;

    while (url) {
      const response = await fetch(url, {
        headers: { 'X-Shopify-Access-Token': shopDoc.accessToken },
      });

      if (!response.ok) {
        return res.status(502).json({ message: `Shopify API error: ${response.status}` });
      }

      const data = await response.json();
      allProducts.push(...(data.products ?? []));

      const linkHeader = response.headers.get('link');
      const nextMatch = linkHeader?.match(/<([^>]+)>;\s*rel="next"/);
      url = nextMatch ? nextMatch[1] : null;
    }

    const products = allProducts.map((p) => ({
      id: p.id.toString(),
      title: p.title,
      productType: p.product_type ?? '',
      variants: (p.variants ?? []).map((v) => ({
        sku: v.sku ?? '',
        price: parseFloat(v.price ?? '0'),
      })),
    }));

    res.json({ products });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/shopify/disconnect
// Removes the connected Shopify store for the current user
// ─────────────────────────────────────────────────────────────────────────────
router.post('/disconnect', authMiddleware, async (req, res) => {
  try {
    await Shop.findOneAndDelete({ userId: req.user.id });
    res.json({ message: 'Shopify store disconnected' });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

module.exports = router;
