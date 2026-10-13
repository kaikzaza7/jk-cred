// Static development server: only public/, loopback access, no secrets or writes.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const securityHeaders = require('./security-headers');

const root = path.resolve(__dirname, '../public');
const port = Number(process.env.JK_DEV_PORT || 4173);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const server = http.createServer(async (req, res) => {
  for (const [name, value] of Object.entries(securityHeaders)) res.setHeader(name, value);
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    const data = await fs.readFile(file);
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    res.writeHead(200);
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch (error) {
    res.writeHead(error.code === 'ENOENT' || error.code === 'EISDIR' ? 404 : 400);
    res.end('Arquivo indisponível.');
  }
});
server.on('error', error => { console.error('Não foi possível iniciar a prévia:', error.code); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`JK CRED: http://127.0.0.1:${server.address().port}`));
