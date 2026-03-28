const express = require('express');
const crypto = require('crypto');
const fetch = require('node-fetch');
const authMiddleware = require('../middleware/auth');
const GoogleAccount = require('../models/GoogleAccount');

const router = express.Router();

const GOOGLE_OAUTH_URL  = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL  = 'https://oauth2.googleapis.com/token';
const GOOGLE_ADS_BASE   = 'https://googleads.googleapis.com/v17';
const GOOGLE_ADS_SCOPE  = 'https://www.googleapis.com/auth/adwords';

// In-memory OAuth state store (same pattern as Shopify / Meta)
const pendingStates = new Map();

function cleanExpiredStates() {
  const now = Date.now();
  for (const [key, val] of pendingStates.entries()) {
    if (val.expiresAt < now) pendingStates.delete(key);
  }
}

/**
 * Returns a valid access token for the given GoogleAccount document.
 * Refreshes using the stored refresh token if the current token has expired
 * (or will expire within 60 seconds).
 */
async function getValidAccessToken(googleDoc) {
  const bufferMs = 60 * 1000; // refresh 60 s before expiry
  if (googleDoc.tokenExpiresAt > Date.now() + bufferMs) {
    return googleDoc.accessToken;
  }

  const params = new URLSearchParams({
    client_id:     process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: googleDoc.refreshToken,
    grant_type:    'refresh_token',
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!res.ok) {
    throw new Error(`Failed to refresh Google access token: ${res.status}`);
  }

  const data = await res.json();
  googleDoc.accessToken    = data.access_token;
  googleDoc.tokenExpiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
  await googleDoc.save();

  return googleDoc.accessToken;
}

/**
 * Sends a GAQL search query to the Google Ads API.
 */
async function gaqlSearch(customerId, accessToken, query) {
  const res = await fetch(`${GOOGLE_ADS_BASE}/customers/${customerId}/googleAds:search`, {
    method: 'POST',
    headers: {
      Authorization:    `Bearer ${accessToken}`,
      'developer-token': process.env.GOOGLE_DEVELOPER_TOKEN,
      'Content-Type':   'application/json',
    },
    body: JSON.stringify({ query }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message ?? `Google Ads API error: ${res.status}`);
  }

  return res.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/google/connect
// Returns the Google OAuth URL for the frontend to redirect to
// ─────────────────────────────────────────────────────────────────────────────
router.get('/connect', authMiddleware, (req, res) => {
  cleanExpiredStates();

  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(req.user.id, { state, expiresAt: Date.now() + 10 * 60 * 1000 });

  const params = new URLSearchParams({
    client_id:     process.env.GOOGLE_CLIENT_ID,
    redirect_uri:  process.env.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope:         GOOGLE_ADS_SCOPE,
    access_type:   'offline',   // required to receive a refresh token
    prompt:        'consent',   // forces consent screen so refresh token is always returned
    state,
  });

  res.json({ url: `${GOOGLE_OAUTH_URL}?${params.toString()}` });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/google/callback
// Body: { code, state }
// Exchanges code for access + refresh tokens, lists accessible customers,
// stores the first accessible customer account.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/callback', authMiddleware, async (req, res) => {
  try {
    const { code, state } = req.body;

    if (!code || !state) {
      return res.status(400).json({ message: 'Missing code or state' });
    }

    // Verify state
    cleanExpiredStates();
    const stored = pendingStates.get(req.user.id);
    if (!stored) {
      return res.status(400).json({ message: 'OAuth state expired or not found. Please try connecting again.' });
    }
    pendingStates.delete(req.user.id);

    const storedBuf   = Buffer.from(stored.state, 'utf8');
    const receivedBuf = Buffer.from(state, 'utf8');
    if (
      storedBuf.length !== receivedBuf.length ||
      !crypto.timingSafeEqual(storedBuf, receivedBuf)
    ) {
      return res.status(400).json({ message: 'Invalid OAuth state' });
    }

    // Exchange code for tokens
    const tokenParams = new URLSearchParams({
      code,
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri:  process.env.GOOGLE_REDIRECT_URI,
      grant_type:    'authorization_code',
    });

    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenParams.toString(),
    });

    if (!tokenRes.ok) {
      const errData = await tokenRes.json().catch(() => ({}));
      return res.status(502).json({
        message: errData?.error_description ?? 'Failed to exchange Google OAuth code',
      });
    }

    const tokenData = await tokenRes.json();
    const accessToken    = tokenData.access_token;
    const refreshToken   = tokenData.refresh_token;
    const tokenExpiresAt = Date.now() + (tokenData.expires_in ?? 3600) * 1000;

    if (!refreshToken) {
      return res.status(502).json({
        message: 'No refresh token returned. Please disconnect and reconnect your Google account to grant offline access.',
      });
    }

    // List accessible Google Ads customer accounts
    const customersRes = await fetch(`${GOOGLE_ADS_BASE}/customers:listAccessibleCustomers`, {
      headers: {
        Authorization:    `Bearer ${accessToken}`,
        'developer-token': process.env.GOOGLE_DEVELOPER_TOKEN,
      },
    });

    if (!customersRes.ok) {
      const errData = await customersRes.json().catch(() => ({}));
      return res.status(502).json({
        message: errData?.error?.message ?? 'Failed to list Google Ads accounts',
      });
    }

    const customersData = await customersRes.json();
    // resourceNames format: "customers/1234567890"
    const resourceNames = customersData.resourceNames ?? [];

    console.log('[google/callback] accessible customers:', resourceNames);

    if (resourceNames.length === 0) {
      return res.status(422).json({
        message: 'No Google Ads accounts found. Make sure you have a Google Ads account linked to this Google account.',
      });
    }

    // Extract numeric customer ID from the first resource name
    const firstCustomerId = resourceNames[0].replace('customers/', '');

    // Fetch account details (name, currency) for the selected customer
    let accountName = firstCustomerId;
    let currency    = 'USD';

    try {
      const detailData = await gaqlSearch(
        firstCustomerId,
        accessToken,
        'SELECT customer.descriptive_name, customer.currency_code FROM customer LIMIT 1',
      );
      const customer = detailData.results?.[0]?.customer;
      if (customer) {
        accountName = customer.descriptiveName ?? firstCustomerId;
        currency    = customer.currencyCode ?? 'USD';
      }
    } catch {
      // Non-critical — account details are cosmetic
    }

    // Upsert GoogleAccount document
    const googleDoc = await GoogleAccount.findOneAndUpdate(
      { userId: req.user.id },
      {
        customerId: firstCustomerId,
        accountName,
        currency,
        accessToken,
        refreshToken,
        tokenExpiresAt,
        installedAt: new Date(),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    res.json({
      account: {
        customerId:  googleDoc.customerId,
        accountName: googleDoc.accountName,
        currency:    googleDoc.currency,
      },
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/google/status
// Returns connected account info or { connected: false }
// ─────────────────────────────────────────────────────────────────────────────
router.get('/status', authMiddleware, async (req, res) => {
  try {
    const googleDoc = await GoogleAccount.findOne({ userId: req.user.id });
    if (!googleDoc) return res.json({ connected: false });

    res.json({
      connected: true,
      account: {
        customerId:  googleDoc.customerId,
        accountName: googleDoc.accountName,
        currency:    googleDoc.currency,
      },
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/google/campaigns?days=60
// Returns Campaign[] (daily spend + revenue arrays) from Google Ads.
// Uses GAQL to query campaign-level metrics with daily date segmentation.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/campaigns', authMiddleware, async (req, res) => {
  try {
    const googleDoc = await GoogleAccount.findOne({ userId: req.user.id });
    if (!googleDoc) return res.status(404).json({ message: 'No Google Ads account connected' });

    const days = Math.min(parseInt(req.query.days ?? '60') || 60, 90);

    const endDate   = new Date();
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const since = startDate.toISOString().slice(0, 10);
    const until = endDate.toISOString().slice(0, 10);

    const accessToken = await getValidAccessToken(googleDoc);

    const query = `
      SELECT
        campaign.id,
        campaign.name,
        metrics.cost_micros,
        metrics.conversions_value,
        segments.date
      FROM campaign
      WHERE segments.date BETWEEN '${since}' AND '${until}'
        AND campaign.status != 'REMOVED'
      ORDER BY segments.date ASC
    `;

    const data = await gaqlSearch(googleDoc.customerId, accessToken, query);
    const rows = data.results ?? [];

    // Build day-index map: date string (YYYY-MM-DD) → array index (0 = oldest)
    startDate.setUTCHours(0, 0, 0, 0);

    const campaignMap = new Map();

    for (const row of rows) {
      const campaignId = row.campaign?.id;
      if (!campaignId) continue;

      if (!campaignMap.has(campaignId)) {
        campaignMap.set(campaignId, {
          id:           campaignId,
          name:         row.campaign.name ?? campaignId,
          channel:      'Google',
          dailySpend:   new Array(days).fill(0),
          dailyRevenue: new Array(days).fill(0),
        });
      }

      const campaign = campaignMap.get(campaignId);

      const rowDate = new Date(row.segments?.date ?? '');
      rowDate.setUTCHours(0, 0, 0, 0);
      const dayIndex = Math.round((rowDate - startDate) / (24 * 60 * 60 * 1000));
      if (dayIndex < 0 || dayIndex >= days) continue;

      // costMicros → dollars (1,000,000 micros = 1 unit)
      campaign.dailySpend[dayIndex]   += (parseInt(row.metrics?.costMicros ?? '0') / 1_000_000);
      campaign.dailyRevenue[dayIndex] += (row.metrics?.conversionsValue ?? 0);
    }

    // Update last synced timestamp
    googleDoc.lastSyncedAt = new Date();
    await googleDoc.save();

    res.json({ campaigns: Array.from(campaignMap.values()), days });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/google/disconnect
// Removes the connected Google Ads account for the current user
// ─────────────────────────────────────────────────────────────────────────────
router.post('/disconnect', authMiddleware, async (req, res) => {
  try {
    await GoogleAccount.findOneAndDelete({ userId: req.user.id });
    res.json({ message: 'Google Ads account disconnected' });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

module.exports = router;
