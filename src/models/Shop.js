const mongoose = require('mongoose');

const shopSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    shopDomain: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    accessToken: {
      type: String,
      required: true,
    },
    shopName: {
      type: String,
      default: '',
    },
    currency: {
      type: String,
      default: 'USD',
    },
    plan: {
      type: String,
      default: '',
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
  { timestamps: true }
);

// Compound index for fast lookup per user+shop
shopSchema.index({ userId: 1, shopDomain: 1 });

module.exports = mongoose.model('Shop', shopSchema);
