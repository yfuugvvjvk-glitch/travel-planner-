const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const ROOT    = __dirname;
const PORT    = 8000;
const DB_FILE = path.join(ROOT, 'data.json');

// ── Baza de date locală (fișier JSON) ─────────────────────────────
function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch (e) { /* fișier corupt — resetăm */ }
  return { locations: [], state: {} };
}

function saveDB(db) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (e) {
    console.error('Eroare la salvarea datelor:', e.message);
  }
}

// ── MIME types ────────────────────────────────────────────────────
const MIME = {
  'html': 'text/html',
  'css':  'text/css',
  'js':   'application/javascript',
  'json': 'application/json',
  'png':  'image/png',
  'jpg':  'image/jpeg',
  'ico':  'image/x-icon',
  'svg':  'image/svg+xml',
  'webmanifest': 'application/manifest+json',
  'xlsx': 'application/octet-stream'
};

// ── Helper: citește body JSON ─────────────────────────────────────
function readBody(req, cb) {
  let body = '';
  req.on('data', chunk => { body += chunk; if (body.length > 52428800) req.destroy(); });
  req.on('end', () => {
    try { cb(null, JSON.parse(body || '{}')); }
    catch (e) { cb(e); }
  });
  req.on('error', cb);
}

// ── Helper: răspuns JSON ──────────────────────────────────────────
function jsonRes(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache'
  });
  res.end(body);
}

// ── Server principal ──────────────────────────────────────────────
const server = http.createServer(function(req, res) {
  const method  = req.method.toUpperCase();
  const urlPath = decodeURIComponent(req.url.split('?')[0]);

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  // ── API: GET /api/locations ──────────────────────────────────────
  if (method === 'GET' && urlPath === '/api/locations') {
    const db = loadDB();
    jsonRes(res, 200, { ok: true, locations: db.locations || [] });
    return;
  }

  // ── API: POST /api/locations ─────────────────────────────────────
  if (method === 'POST' && urlPath === '/api/locations') {
    readBody(req, (err, loc) => {
      if (err || !loc.id) { jsonRes(res, 400, { ok: false, error: 'date invalide' }); return; }
      const db = loadDB();
      const idx = db.locations.findIndex(l => l.id === loc.id);
      if (idx !== -1) {
        db.locations[idx] = loc;
      } else {
        db.locations.push(loc);
      }
      saveDB(db);
      jsonRes(res, 200, { ok: true });
    });
    return;
  }

  // ── API: PUT /api/locations/reorder ──────────────────────────────
  if (method === 'PUT' && urlPath === '/api/locations/reorder') {
    readBody(req, (err, body) => {
      if (err || !body.order) { jsonRes(res, 400, { ok: false, error: 'date invalide' }); return; }
      const db = loadDB();
      const ordered = body.order.map(id => db.locations.find(l => l.id === id)).filter(Boolean);
      const rest = db.locations.filter(l => !body.order.includes(l.id));
      db.locations = [...ordered, ...rest];
      saveDB(db);
      jsonRes(res, 200, { ok: true });
    });
    return;
  }

  // ── API: DELETE /api/locations/:id ───────────────────────────────
  if (method === 'DELETE' && urlPath.startsWith('/api/locations/') && urlPath.length > '/api/locations/'.length) {
    const id = urlPath.slice('/api/locations/'.length);
    const db = loadDB();
    db.locations = db.locations.filter(l => l.id !== id);
    saveDB(db);
    jsonRes(res, 200, { ok: true });
    return;
  }

  // ── API: DELETE /api/locations (toate) ───────────────────────────
  if (method === 'DELETE' && urlPath === '/api/locations') {
    const db = loadDB();
    db.locations = [];
    saveDB(db);
    jsonRes(res, 200, { ok: true });
    return;
  }

  // ── API: GET /api/state ──────────────────────────────────────────
  if (method === 'GET' && urlPath === '/api/state') {
    const db = loadDB();
    jsonRes(res, 200, { ok: true, state: db.state || {} });
    return;
  }

  // ── API: POST /api/state ─────────────────────────────────────────
  if (method === 'POST' && urlPath === '/api/state') {
    readBody(req, (err, body) => {
      if (err) { jsonRes(res, 400, { ok: false, error: 'date invalide' }); return; }
      const db = loadDB();
      db.state = Object.assign({}, db.state || {}, body);
      saveDB(db);
      jsonRes(res, 200, { ok: true });
    });
    return;
  }

  // ── API: POST /api/import ────────────────────────────────────────
  if (method === 'POST' && urlPath === '/api/import') {
    readBody(req, (err, body) => {
      if (err) { jsonRes(res, 400, { ok: false, error: 'date invalide' }); return; }
      const db = loadDB();
      db.locations = body.locations || [];
      if (body.start !== undefined) db.state = Object.assign({}, db.state || {}, { start: body.start });
      if (body.mode) db.state = Object.assign({}, db.state || {}, { mode: body.mode });
      saveDB(db);
      jsonRes(res, 200, { ok: true, count: db.locations.length });
    });
    return;
  }

  // ── Fișiere statice ──────────────────────────────────────────────
  var rel = urlPath === '/' ? '/index.html' : urlPath;
  var f   = path.join(ROOT, rel);

  if (!f.startsWith(ROOT)) {
    res.writeHead(403); res.end(); return;
  }

  var ext = path.extname(f).slice(1).toLowerCase();

  fs.access(f, fs.constants.R_OK, function(err) {
    if (err) {
      res.writeHead(404); res.end('Not found'); return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'text/plain',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(f).pipe(res);
  });
});

server.on('error', function(err) {
  if (err.code === 'EADDRINUSE') {
    console.error('');
    console.error('  EROARE: Portul ' + PORT + ' este deja folosit!');
    console.error('  Inchide fereastra veche a serverului si incearca din nou.');
    console.error('');
    process.exit(1);
  } else {
    throw err;
  }
});

server.listen(PORT, '0.0.0.0', function() {
  console.log('');
  console.log('================================================');
  console.log('  Planificator Traseu - Server pornit!');
  console.log('================================================');
  console.log('  Local:   http://localhost:' + PORT);

  try {
    const ifaces = os.networkInterfaces();
    Object.values(ifaces).forEach(list => {
      list.forEach(iface => {
        if (iface.family === 'IPv4' && !iface.internal) {
          console.log('  WiFi:    http://' + iface.address + ':' + PORT);
        }
      });
    });
  } catch (e) {}

  console.log('================================================');
  console.log('  Date salvate in: data.json');
  console.log('  Nu inchide aceasta fereastra!');
  console.log('================================================');
  console.log('');
});
