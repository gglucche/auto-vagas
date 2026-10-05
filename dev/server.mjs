// Preview server: opens the dashboard in the browser with the chrome.* API mocked.
// Usage: node dev/server.mjs  →  http://localhost:5178/ui/dashboard.html  (?empty for the first-run state)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const file = path.join(root, url.pathname === '/' ? 'ui/dashboard.html' : decodeURIComponent(url.pathname));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end('not found');
    }
    let body = fs.readFileSync(file);
    const ext = path.extname(file);
    if (ext === '.html') body = String(body).replace('<head>', '<head><script src="/dev/mock-chrome.js"></script>');
    res.writeHead(200, { 'content-type': (types[ext] || 'application/octet-stream') + '; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  })
  .listen(5178, () => console.log('http://localhost:5178/ui/dashboard.html'));
