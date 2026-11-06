// Static server for the harness: node dev/serve.mjs [port]  →  http://localhost:5178/dev/harness.html
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] ?? 5178);
const TYPES = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg' };

http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const file = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
  if (!file.startsWith(root)) {
    response.writeHead(403).end();
    return;
  }
  fs.readFile(file, (error, data) => {
    if (error) {
      response.writeHead(404).end('not found');
      return;
    }
    response.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(data);
  });
}).listen(port, '127.0.0.1', () => console.log(`harness: http://localhost:${port}/dev/harness.html`));
