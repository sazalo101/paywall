require('dotenv').config(); // Load environment variables
const express = require('express');
const { Client } = require('pg'); // PostgreSQL client
const { TonConnect } = require('@tonconnect/sdk');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// PostgreSQL client setup
const client = new Client({
  connectionString: process.env.DATABASE_URL, // Use environment variable for database URL
  ssl: {
    rejectUnauthorized: false, // Required for Render's PostgreSQL
  },
});

client.connect()
  .then(() => console.log('Connected to PostgreSQL'))
  .catch(err => console.error('Connection error', err.stack));

// TON Connect setup
const connector = new TonConnect({
  manifestUrl: process.env.TON_CONNECT_MANIFEST_URL, // Use environment variable
});

// Your TON wallet address to receive fees
const YOUR_WALLET_ADDRESS = process.env.YOUR_WALLET_ADDRESS; // Use environment variable

// Service fee (0.10 USDT)
const SERVICE_FEE = 0.10;

// Endpoint for creators to connect their wallet
app.post('/connect-wallet', (req, res) => {
  const { creatorId, walletAddress } = req.body;
  client.query(
    'INSERT INTO creators (id, walletAddress) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET walletAddress = $2',
    [creatorId, walletAddress],
    (err) => {
      if (err) return res.status(500).json({ error: 'Database error' });
      res.json({ success: true });
    }
  );
});

// Endpoint for creators to add paywalled content
app.post('/create-content', (req, res) => {
  const { type, title, description, url, price, creatorId, groupId } = req.body;

  // Generate a unique content ID based on group ID and timestamp
  const contentId = `${groupId}-${Date.now()}`;

  client.query(
    'INSERT INTO content (id, type, title, description, url, price, creatorId, groupId) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
    [contentId, type, title, description, url, price, creatorId, groupId],
    (err) => {
      if (err) return res.status(500).json({ error: 'Database error' });
      res.json({ contentId });
    }
  );
});

// Endpoint for users to pay for content
app.post('/pay-for-content', async (req, res) => {
  const { contentId, userId, txHash } = req.body;

  // Fetch content details
  client.query('SELECT * FROM content WHERE id = $1', [contentId], async (err, contentResult) => {
    if (err || !contentResult.rows[0]) {
      return res.status(404).json({ error: 'Content not found' });
    }
    const content = contentResult.rows[0];

    // Fetch creator's wallet address
    client.query('SELECT * FROM creators WHERE id = $1', [content.creatorId], async (err, creatorResult) => {
      if (err || !creatorResult.rows[0]) {
        return res.status(404).json({ error: 'Creator not found' });
      }
      const creator = creatorResult.rows[0];

      // Verify the transaction on the TON blockchain
      const tx = await connector.getTransaction(txHash);
      if (!tx || tx.amount < (content.price + SERVICE_FEE) * 1e6) { // Convert to smallest units
        return res.status(400).json({ error: 'Invalid payment' });
      }

      // Save payment record
      const creatorEarnings = content.price;
      client.query(
        'INSERT INTO payments (contentId, userId, txHash, amount, serviceFee, creatorEarnings) VALUES ($1, $2, $3, $4, $5, $6)',
        [contentId, userId, txHash, content.price, SERVICE_FEE, creatorEarnings],
        (err) => {
          if (err) return res.status(500).json({ error: 'Database error' });
          res.json({ success: true });
        }
      );
    });
  });
});

// Endpoint to fetch content (only for paid users)
app.get('/content/:groupId', (req, res) => {
  const { groupId } = req.params;
  const { userId } = req.query;

  client.query(
    'SELECT * FROM payments WHERE contentId LIKE $1 AND userId = $2',
    [`${groupId}-%`, userId],
    (err, paymentResult) => {
      if (err || !paymentResult.rows[0]) {
        return res.status(403).json({ error: 'Payment required' });
      }
      const payment = paymentResult.rows[0];

      client.query('SELECT * FROM content WHERE id = $1', [payment.contentId], (err, contentResult) => {
        if (err || !contentResult.rows[0]) {
          return res.status(404).json({ error: 'Content not found' });
        }
        const content = contentResult.rows[0];
        res.json({ content });
      });
    }
  );
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});