require('dotenv').config();
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

// Custom storage implementation
const customStorage = {
  storage: {},
  getItem(key) {
    return this.storage[key] || null;
  },
  setItem(key, value) {
    this.storage[key] = value;
  },
  removeItem(key) {
    delete this.storage[key];
  },
};

// TON Connect setup with custom storage
const connector = new TonConnect({
  manifestUrl: process.env.TON_CONNECT_MANIFEST_URL,
  storage: customStorage, // Use custom storage
});

// Endpoint to create content
app.post('/create-content', async (req, res) => {
  const { type, title, description, url, price, creatorId, groupId, txHash } = req.body;

  // Verify the 0.75 USDT fee transaction
  const tx = await connector.getTransaction(txHash);
  if (!tx || tx.amount < 0.75 * 1e6) {
    return res.status(400).json({ error: 'Invalid fee payment' });
  }

  // Generate a unique content ID
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

// Endpoint to fetch content
app.get('/content/:groupId', (req, res) => {
  const { groupId } = req.params;

  db.all('SELECT * FROM content WHERE groupId = ?', [groupId], (err, content) => {
    if (err || !content) {
      return res.status(404).json({ error: 'Content not found' });
    }
    res.json({ content });
  });
});

// Endpoint to pay for content
app.post('/pay-for-content', async (req, res) => {
  const { contentId, userId, txHash } = req.body;

  // Fetch content details
  db.get('SELECT * FROM content WHERE id = ?', [contentId], async (err, content) => {
    if (err || !content) {
      return res.status(404).json({ error: 'Content not found' });
    }

    // Verify the transaction
    const tx = await connector.getTransaction(txHash);
    if (!tx || tx.amount < (content.price + 0.10) * 1e6) {
      return res.status(400).json({ error: 'Invalid payment' });
    }

    // Save payment record
    db.run(
      'INSERT INTO payments (contentId, userId, txHash, amount, serviceFee, creatorEarnings) VALUES (?, ?, ?, ?, ?, ?)',
      [contentId, userId, txHash, content.price, 0.10, content.price],
      (err) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json({ success: true });
      }
    );
  });
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});