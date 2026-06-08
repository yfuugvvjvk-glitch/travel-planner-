// Server minimal pentru standalone PWA
const http = require('http');
const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = __dirname;
const PORT = 8765;

const MIME = {
  'html': 'text/html', 'css': 'text/css', 'js': 'application/javascript',
  'json': 'application/json', 'png': 'image/png', 'jpg': 'image/jpeg',
  'svg': 'image/svg+xml', 'ico': 'image/x-icon', 'webmanifest': 'application/manifest+json',
  'bat': 'application/octet-stream', 'zip': 'application/zip'
};

// Fisierele care fac parte din aplicatie
const APP_FILES = [
  'index.html', 'app.js', 'db.js', 'locations.js', 'routing.js',
  'ui.js', 'style.css', 'sw.js', 'manifest.json', 'server.js',
  'icon-192.svg', 'icon-512.svg', 'Porneste Aplicatia.bat'
];

// ── ZIP simplu (fara dependente externe) ─────────────────────────
function buildZip(files) {
  // Format ZIP manual - local file headers + central directory
  const entries = [];
  let offset = 0;

  for (const { name, data } of files) {
    const nameBytes = Buffer.from(name, 'utf8');
    const dosDate = dosDateTime(new Date());

    // Local file header
    const localHeader = Buffer.alloc(30 + nameBytes.length);
    localHeader.writeUInt32LE(0x04034b50, 0);  // signature
    localHeader.writeUInt16LE(20, 4);           // version needed
    localHeader.writeUInt16LE(0, 6);            // flags
    localHeader.writeUInt16LE(0, 8);            // compression: stored
    localHeader.writeUInt16LE(dosDate.time, 10);
    localHeader.writeUInt16LE(dosDate.date, 12);
    const crc = crc32(data);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18); // compressed size
    localHeader.writeUInt32LE(data.length, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);           // extra field length
    nameBytes.copy(localHeader, 30);

    entries.push({ name, nameBytes, data, localHeader, offset, crc });
    offset += localHeader.length + data.length;
  }

  // Central directory
  const centralParts = [];
  for (const e of entries) {
    const cd = Buffer.alloc(46 + e.nameBytes.length);
    const dosDate = dosDateTime(new Date());
    cd.writeUInt32LE(0x02014b50, 0);  // signature
    cd.writeUInt16LE(20, 4);          // version made by
    cd.writeUInt16LE(20, 6);          // version needed
    cd.writeUInt16LE(0, 8);           // flags
    cd.writeUInt16LE(0, 10);          // compression
    cd.writeUInt16LE(dosDate.time, 12);
    cd.writeUInt16LE(dosDate.date, 14);
    cd.writeUInt32LE(e.crc, 16);
    cd.writeUInt32LE(e.data.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(e.nameBytes.length, 28);
    cd.writeUInt16LE(0, 30);          // extra
    cd.writeUInt16LE(0, 32);          // comment
    cd.writeUInt16LE(0, 34);          // disk start
    cd.writeUInt16LE(0, 36);          // internal attr
    cd.writeUInt32LE(0, 38);          // external attr
    cd.writeUInt32LE(e.offset, 42);   // local header offset
    e.nameBytes.copy(cd, 46);
    centralParts.push(cd);
  }

  const centralDir = Buffer.concat(centralParts);
  const cdOffset = offset;

  // End of central directory
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);

  const parts = [];
  for (const e of entries) {
    parts.push(e.localHeader);
    parts.push(e.data);
  }
  parts.push(centralDir);
  parts.push(eocd);
  return Buffer.concat(parts);
}

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c;
    }
    return t;
  })());
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ── HTTP Server ───────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);

  // ── Ruta download ZIP ─────────────────────────────────────────
  if (urlPath === '/download-app') {
    try {
      const files = [];
      for (const name of APP_FILES) {
        const filePath = path.join(ROOT, name);
        if (fs.existsSync(filePath)) {
          files.push({ name: 'traseu-standalone/' + name, data: fs.readFileSync(filePath) });
        }
      }
      const zip = buildZip(files);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="traseu-standalone.zip"',
        'Content-Length': zip.length,
        'Access-Control-Allow-Origin': '*'
      });
      res.end(zip);
    } catch (e) {
      res.writeHead(500); res.end('Eroare: ' + e.message);
    }
    return;
  }

  // ── Fisiere statice ───────────────────────────────────────────
  if (urlPath === '/') urlPath = '/index.html';
  const f = path.join(ROOT, urlPath);
  if (!f.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }

  fs.access(f, fs.constants.R_OK, err => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(f).slice(1).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'text/plain',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*'
    });
    fs.createReadStream(f).pipe(res);
  });
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.log('');
    console.log('  Aplicatia deja ruleaza la: http://localhost:' + PORT);
    console.log('  Deschide browserul manual daca nu s-a deschis automat.');
    console.log('');
    process.exit(0);
  } else throw err;
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('Server pornit pe http://localhost:' + PORT);
  openBrowser();
});

function openBrowser() {
  const url = 'http://localhost:' + PORT;
  const { exec } = require('child_process');
  const urlWithTs = url + '?v=' + Date.now();
  const chromePaths = [
    '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"',
    '"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"',
    '"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"',
    '"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"',
  ];
  function tryNext(i) {
    if (i >= chromePaths.length) { exec(`start "" "${urlWithTs}"`); return; }
    exec(`${chromePaths[i]} --app=${urlWithTs} --window-size=1400,900 --no-first-run --disable-extensions --disk-cache-size=1`, err => {
      if (err) tryNext(i + 1);
    });
  }
  tryNext(0);
}
