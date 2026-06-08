const express = require('express');
const mysql   = require('mysql2/promise');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ── Serveste fișierele statice ale aplicației ──────────────────────
const PUBLIC = '/app/public';
app.use(express.static(PUBLIC));

// ── Conexiune MySQL cu retry ───────────────────────────────────────
let db;
async function connectDB() {
  for (let i = 0; i < 20; i++) {
    try {
      db = await mysql.createPool({
        host:     process.env.DB_HOST     || 'localhost',
        port:     process.env.DB_PORT     || 3306,
        user:     process.env.DB_USER     || 'traseu_user',
        password: process.env.DB_PASSWORD || 'traseu2026',
        database: process.env.DB_NAME     || 'traseu',
        waitForConnections: true,
        connectionLimit: 10,
        charset: 'utf8mb4'
      });
      await db.query('SELECT 1');
      console.log('✓ Conectat la MySQL');

      // Creează tabelele dacă nu există (safe pentru volume existente)
      await db.query(`
        CREATE TABLE IF NOT EXISTS locations (
          id VARCHAR(32) PRIMARY KEY,
          data JSON NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS app_state (
          key_name VARCHAR(64) PRIMARY KEY,
          value JSON NOT NULL,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
      `);
      console.log('✓ Tabele verificate/create');
      return;
    } catch (e) {
      console.log(`Aștept MySQL... (${i+1}/20)`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  console.error('Nu m-am putut conecta la MySQL!');
  process.exit(1);
}

// ── API: GET toate locațiile ───────────────────────────────────────
app.get('/api/locations', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT id, data FROM locations ORDER BY JSON_EXTRACT(data, "$.order") ASC, created_at ASC');
    const locations = rows.map(r => {
      const data = (typeof r.data === 'string') ? JSON.parse(r.data) : r.data;
      return { id: r.id, ...data };
    });
    res.json({ ok: true, locations });
  } catch (e) {
    console.error('GET /api/locations error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── API: POST adaugă/actualizează o locație ────────────────────────
app.post('/api/locations', async (req, res) => {
  try {
    const loc = req.body;
    if (!loc.id) return res.status(400).json({ ok: false, error: 'id lipsă' });
    const { id, ...data } = loc;
    const dataStr = JSON.stringify(data);
    await db.query(
      'INSERT INTO locations (id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data = ?, updated_at = NOW()',
      [id, dataStr, dataStr]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/locations error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── API: PUT actualizează ordinea (bulk) ───────────────────────────
app.put('/api/locations/reorder', async (req, res) => {
  try {
    const { order } = req.body; // array de id-uri în ordine nouă
    for (let i = 0; i < order.length; i++) {
      await db.query(
        'UPDATE locations SET data = JSON_SET(data, "$.order", ?) WHERE id = ?',
        [i, order[i]]
      );
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── API: DELETE șterge o locație ───────────────────────────────────
app.delete('/api/locations/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM locations WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── API: DELETE șterge toate locațiile ────────────────────────────
app.delete('/api/locations', async (req, res) => {
  try {
    await db.query('DELETE FROM locations');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── API: GET/POST starea aplicației (start, mode) ─────────────────
app.get('/api/state', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT key_name, value FROM app_state');
    const state = {};
    rows.forEach(r => {
      try {
        // value poate fi JSON valid, string simplu, sau obiect deja parsat
        if (typeof r.value === 'object' && r.value !== null) {
          state[r.key_name] = r.value;
        } else {
          state[r.key_name] = JSON.parse(r.value);
        }
      } catch {
        // dacă nu e JSON valid, folosim valoarea ca string direct
        state[r.key_name] = r.value;
      }
    });
    res.json({ ok: true, state });
  } catch (e) {
    console.error('GET /api/state error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/state', async (req, res) => {
  try {
    const entries = Object.entries(req.body);
    for (const [key, value] of entries) {
      const valStr = JSON.stringify(value);
      await db.query(
        'INSERT INTO app_state (key_name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = ?, updated_at = NOW()',
        [key, valStr, valStr]
      );
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/state error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── API: POST import bulk (înlocuiește tot) ────────────────────────
app.post('/api/import', async (req, res) => {
  try {
    const { locations, start, mode } = req.body;
    await db.query('DELETE FROM locations');
    if (locations && locations.length) {
      for (let i = 0; i < locations.length; i++) {
        const { id, ...data } = locations[i];
        data.order = i;
        await db.query(
          'INSERT INTO locations (id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data = ?',
          [id, JSON.stringify(data), JSON.stringify(data)]
        );
      }
    }
    if (start !== undefined) {
      await db.query(
        'INSERT INTO app_state (key_name, value) VALUES ("start", ?) ON DUPLICATE KEY UPDATE value = ?',
        [JSON.stringify(start), JSON.stringify(start)]
      );
    }
    if (mode) {
      await db.query(
        'INSERT INTO app_state (key_name, value) VALUES ("mode", ?) ON DUPLICATE KEY UPDATE value = ?',
        [JSON.stringify(mode), JSON.stringify(mode)]
      );
    }
    res.json({ ok: true, count: locations ? locations.length : 0 });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Fallback: servește index.html pentru orice altă rută ──────────
app.get('*', (req, res) => {
  res.sendFile(path.join(PUBLIC, 'index.html'));
});

// ── Start ──────────────────────────────────────────────────────────
connectDB().then(() => {
  app.listen(8000, '0.0.0.0', () => {
    console.log('Server pornit pe portul 8000');
  });
});
