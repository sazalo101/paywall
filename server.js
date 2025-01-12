require('dotenv').config(); // Load environment variables
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { TonConnect } = require('@tonconnect/sdk');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());

// SQLite database setup
const dbPath = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS creators (
      id TEXT PRIMARY KEY,
      walletAddress TEXT
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS content (
      id TEXT PRIMARY KEY,
      type TEXT CHECK(type IN ('file', 'link', 'course')),
      title TEXT,
      description TEXT,
      url TEXT,
      price REAL,
      creatorId TEXT,
      groupId TEXT
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contentId TEXT,
      userId TEXT,
      txHash TEXT,
      amount REAL,
      serviceFee REAL,
      creatorEarnings REAL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

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
  db.run(
    'INSERT OR REPLACE INTO creators (id, walletAddress) VALUES (?, ?)',
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

  db.run(
    'INSERT INTO content (id, type, title, description, url, price, creatorId, groupId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
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
  db.get('SELECT * FROM content WHERE id = ?', [contentId], async (err, content) => {
    if (err || !content) {
      return res.status(404).json({ error: 'Content not found' });
    }

    // Fetch creator's wallet address
    db.get('SELECT * FROM creators WHERE id = ?', [content.creatorId], async (err, creator) => {
      if (err || !creator) {
        return res.status(404).json({ error: 'Creator not found' });
      }

      // Verify the transaction on the TON blockchain
      const tx = await connector.getTransaction(txHash);
      if (!tx || tx.amount < (content.price + SERVICE_FEE) * 1e6) { // Convert to smallest units
        return res.status(400).json({ error: 'Invalid payment' });
      }

      // Save payment record
      const creatorEarnings = content.price;
      db.run(
        'INSERT INTO payments (contentId, userId, txHash, amount, serviceFee, creatorEarnings) VALUES (?, ?, ?, ?, ?, ?)',
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

  db.get(
    'SELECT * FROM payments WHERE contentId LIKE ? AND userId = ?',
    [`${groupId}-%`, userId],
    (err, payment) => {
      if (err || !payment) {
        return res.status(403).json({ error: 'Payment required' });
      }

      db.get('SELECT * FROM content WHERE id = ?', [payment.contentId], (err, content) => {
        if (err || !content) {
          return res.status(404).json({ error: 'Content not found' });
        }
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