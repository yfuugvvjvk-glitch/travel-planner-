const http = require('http');
const fs   = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = 8000;

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

http.createServer(function(req, res) {
  var rel = decodeURIComponent(req.url === '/' ? '/index.html' : req.url.split('?')[0]);
  var f   = path.join(ROOT, rel);

  // securitate: nu permite iesirea din ROOT
  if (!f.startsWith(ROOT)) {
    res.writeHead(403); res.end(); return;
  }

  var ext = path.extname(f).slice(1).toLowerCase();

  fs.access(f, fs.constants.R_OK, function(err) {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'text/plain',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(f).pipe(res);
  });

}).listen(PORT, '0.0.0.0', function() {
  console.log('Server activ pe toate interfetele, port ' + PORT);
});
