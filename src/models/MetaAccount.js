const mongoose = require('mongoose');

const metaAccountSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    // Meta ad account ID, always prefixed with "act_"
    adAccountId: {
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
    // Long-lived user access token (60-day expiry)
    accessToken: {
      type: String,
      required: true,
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

metaAccountSchema.index({ userId: 1 });

module.exports = mongoose.model('MetaAccount', metaAccountSchema);
