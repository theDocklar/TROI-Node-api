const express = require('express');
const crypto = require('crypto');
const fetch = require('node-fetch');
const authMiddleware = require('../middleware/auth');
const MetaAccount = require('../models/MetaAccount');

const router = express.Router();

const GRAPH_URL = 'https://graph.facebook.com/v21.0';

// In-memory OAuth state store (same pattern as Shopify)
const pendingStates = new Map();

function cleanExpiredStates() {
  const now = Date.now();
  for (const [key, val] of pendingStates.entries()) {
    if (val.expiresAt < now) pendingStates.delete(key);
  }
}

function graphRequest(path, accessToken, extraParams = {}) {
  const params = new URLSearchParams({ access_token: accessToken, ...extraParams });
  return fetch(`${GRAPH_URL}${path}?${params.toString()}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/meta/connect
// Returns the Meta OAuth URL for the frontend to redirect to
// ─────────────────────────────────────────────────────────────────────────────
router.get('/connect', authMiddleware, (req, res) => {
  cleanExpiredStates();

  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(req.user.id, { state, expiresAt: Date.now() + 10 * 60 * 1000 });

  const params = new URLSearchParams({
    client_id: process.env.META_APP_ID,
    redirect_uri: process.env.META_REDIRECT_URI,
    scope: 'ads_read,read_insights',
    state,
    response_type: 'code',
  });

  const url = `https://www.facebook.com/v21.0/dialog/oauth?${params.toString()}`;
  res.json({ url });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/meta/callback
// Body: { code, state }
// Exchanges code for a long-lived token, fetches ad accounts, stores first active one
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

    const storedBuf = Buffer.from(stored.state, 'utf8');
    const receivedBuf = Buffer.from(state, 'utf8');
    if (
      storedBuf.length !== receivedBuf.length ||
      !crypto.timingSafeEqual(storedBuf, receivedBuf)
    ) {
      return res.status(400).json({ message: 'Invalid OAuth state' });
    }

    // Exchange code for short-lived access token
    const tokenParams = new URLSearchParams({
      client_id: process.env.META_APP_ID,
      client_secret: process.env.META_APP_SECRET,
      redirect_uri: process.env.META_REDIRECT_URI,
      code,
    });
    const tokenRes = await fetch(`${GRAPH_URL}/oauth/access_token?${tokenParams.toString()}`);

    if (!tokenRes.ok) {
      const errData = await tokenRes.json().catch(() => ({}));
      return res.status(502).json({
        message: errData?.error?.message ?? 'Failed to exchange Meta OAuth code',
      });
    }

    const { access_token: shortToken } = await tokenRes.json();

    // Exchange for a long-lived token (60-day expiry)
    const longTokenParams = new URLSearchParams({
      grant_type: 'fb_exchange_token',
      client_id: process.env.META_APP_ID,
      client_secret: process.env.META_APP_SECRET,
      fb_exchange_token: shortToken,
    });
    const longTokenRes = await fetch(`${GRAPH_URL}/oauth/access_token?${longTokenParams.toString()}`);

    let accessToken = shortToken;
    if (longTokenRes.ok) {
      const longData = await longTokenRes.json();
      accessToken = longData.access_token ?? shortToken;
    }

    // Fetch user's ad accounts
    const accountsRes = await graphRequest('/me/adaccounts', accessToken, {
      fields: 'id,name,currency,account_status',
      limit: '20',
    });

    if (!accountsRes.ok) {
      return res.status(502).json({ message: 'Failed to fetch Meta ad accounts' });
    }

    const accountsData = await accountsRes.json();
    const accounts = accountsData.data ?? [];

    console.log('[meta/callback] ad accounts response:', JSON.stringify(accountsData, null, 2));

    if (accounts.length === 0) {
      return res.status(422).json({
        message:
          'No Meta ad accounts found. Make sure you have a Facebook Ads account and that you granted "ads_read" permission during the OAuth flow.',
      });
    }

    // Prefer active accounts (status 1 = ACTIVE), fall back to first available
    const activeAccount = accounts.find((a) => a.account_status === 1) ?? accounts[0];

    // Upsert MetaAccount document
    const metaDoc = await MetaAccount.findOneAndUpdate(
      { userId: req.user.id },
      {
        adAccountId: activeAccount.id,
        accountName: activeAccount.name ?? '',
        currency: activeAccount.currency ?? 'USD',
        accessToken,
        installedAt: new Date(),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    res.json({
      account: {
        adAccountId: metaDoc.adAccountId,
        accountName: metaDoc.accountName,
        currency: metaDoc.currency,
      },
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/meta/status
// Returns connected ad account info or { connected: false }
// ─────────────────────────────────────────────────────────────────────────────
router.get('/status', authMiddleware, async (req, res) => {
  try {
    const metaDoc = await MetaAccount.findOne({ userId: req.user.id });
    if (!metaDoc) return res.json({ connected: false });

    res.json({
      connected: true,
      account: {
        adAccountId: metaDoc.adAccountId,
        accountName: metaDoc.accountName,
        currency: metaDoc.currency,
      },
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/meta/campaigns?days=60
// Returns Campaign[] (daily spend + revenue arrays) from Meta Insights API.
// Each campaign represents one Meta campaign with per-day spend and pixel revenue.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/campaigns', authMiddleware, async (req, res) => {
  try {
    const metaDoc = await MetaAccount.findOne({ userId: req.user.id });
    if (!metaDoc) return res.status(404).json({ message: 'No Meta account connected' });

    const days = Math.min(parseInt(req.query.days ?? '60') || 60, 90);

    const endDate = new Date();
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const timeRange = JSON.stringify({
      since: startDate.toISOString().slice(0, 10),
      until: endDate.toISOString().slice(0, 10),
    });

    // Fetch daily campaign-level insights from Meta
    // time_increment=1 gives one row per campaign per day
    const insightParams = {
      level: 'campaign',
      fields: 'campaign_id,campaign_name,spend,actions,action_values',
      time_increment: '1',
      time_range: timeRange,
      limit: '500',
    };

    const allRows = [];
    let nextUrl = null;

    const firstRes = await graphRequest(
      `/${metaDoc.adAccountId}/insights`,
      metaDoc.accessToken,
      insightParams,
    );

    if (!firstRes.ok) {
      const errData = await firstRes.json().catch(() => ({}));
      return res.status(502).json({
        message: errData?.error?.message ?? `Meta Insights API error: ${firstRes.status}`,
      });
    }

    const firstData = await firstRes.json();
    allRows.push(...(firstData.data ?? []));
    nextUrl = firstData.paging?.next ?? null;

    // Follow pagination
    while (nextUrl) {
      const pageRes = await fetch(nextUrl);
      if (!pageRes.ok) break;
      const pageData = await pageRes.json();
      allRows.push(...(pageData.data ?? []));
      nextUrl = pageData.paging?.next ?? null;
    }

    // Build a day-index map: date string → array index (0 = oldest, days-1 = today)
    startDate.setUTCHours(0, 0, 0, 0);

    // Aggregate rows by campaign → { id, name, dailySpend[], dailyRevenue[] }
    const campaignMap = new Map();

    for (const row of allRows) {
      const campaignId = row.campaign_id;
      if (!campaignId) continue;

      if (!campaignMap.has(campaignId)) {
        campaignMap.set(campaignId, {
          id: campaignId,
          name: row.campaign_name ?? campaignId,
          channel: 'Meta',
          dailySpend: new Array(days).fill(0),
          dailyRevenue: new Array(days).fill(0),
        });
      }

      const campaign = campaignMap.get(campaignId);

      // Map date to day index
      const rowDate = new Date(row.date_start ?? row.date_stop);
      rowDate.setUTCHours(0, 0, 0, 0);
      const dayIndex = Math.round((rowDate - startDate) / (24 * 60 * 60 * 1000));
      if (dayIndex < 0 || dayIndex >= days) continue;

      campaign.dailySpend[dayIndex] += parseFloat(row.spend ?? '0');

      // Sum purchase revenue from action_values
      for (const av of row.action_values ?? []) {
        if (
          av.action_type === 'purchase' ||
          av.action_type === 'offsite_conversion.fb_pixel_purchase'
        ) {
          campaign.dailyRevenue[dayIndex] += parseFloat(av.value ?? '0');
        }
      }
    }

    // Update last synced timestamp
    metaDoc.lastSyncedAt = new Date();
    await metaDoc.save();

    res.json({ campaigns: Array.from(campaignMap.values()), days });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/meta/disconnect
// Removes the connected Meta ad account for the current user
// ─────────────────────────────────────────────────────────────────────────────
router.post('/disconnect', authMiddleware, async (req, res) => {
  try {
    await MetaAccount.findOneAndDelete({ userId: req.user.id });
    res.json({ message: 'Meta account disconnected' });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

module.exports = router;
