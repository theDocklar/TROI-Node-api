const mongoose = require('mongoose');

const googleAccountSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    // Google Ads customer ID (digits only, no dashes)
    customerId: {
      type: String,
      required: true,
    },
    accountName: {
      type: String,
      default: '',
    },
    currency: {
      type: String,
      default: 'USD',
    },
    // Short-lived access token (refreshed automatically before each API call)
    accessToken: {
      type: String,
      required: true,
    },
    // Long-lived refresh token (does not expire unless revoked)
    refreshToken: {
      type: String,
      required: true,
    },
    // Unix timestamp (ms) when the current access token expires
    tokenExpiresAt: {
      type: Number,
      default: 0,
    },
    installedAt: {
      type: Date,
      default: Date.now,
    },
    lastSyncedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

googleAccountSchema.index({ userId: 1 });

module.exports = mongoose.model('GoogleAccount', googleAccountSchema);
