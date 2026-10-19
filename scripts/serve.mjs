// Zero-dependency local server: serves dist/ and runs api/explain.js like Vercel does.
//   npm run dev   → http://localhost:3000
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
// Load .env if present (no dotenv dependency).
if (existsSync(join(ROOT, '.env'))) {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.csv': 'text/csv; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };
const { default: explain } = await import(join(ROOT, 'api/explain.js'));
const port = Number(process.env.PORT || 3000);

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/explain') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const r = {
      status(code) { res.statusCode = code; return r; },
      json(obj) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); },
    };
    try { await explain({ method: req.method, body: body ? JSON.parse(body) : {} }, r); } catch (e) { r.status(500).json({ error: String(e) }); }
    return;
  }
  let p = normalize(join(DIST, decodeURIComponent(url.pathname)));
  if (!p.startsWith(DIST)) { res.statusCode = 403; return res.end(); }
  try { if ((await stat(p)).isDirectory()) p = join(p, 'index.html'); } catch { p = join(DIST, 'index.html'); }
  try {
    const data = await readFile(p);
    res.setHeader('content-type', TYPES[extname(p)] || 'application/octet-stream');
    res.end(data);
  } catch { res.statusCode = 404; res.end('Not found'); }
}).listen(port, () => console.log(`NeoCloud Payroll running at http://localhost:${port}`));
