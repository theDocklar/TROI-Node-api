const express = require('express');
const cors = require('cors');
const authRoutes = require('./routes/auth');
const shopifyRoutes = require('./routes/shopify');
const metaRoutes = require('./routes/meta');

const app = express();

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/auth', authRoutes);
app.use('/api/shopify', shopifyRoutes);
app.use('/api/meta', metaRoutes);

module.exports = app;
