// 网页版服务：零依赖 node:http，Token 只在服务端，前端永远拿不到
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runSaver } from '../src/saver.mjs';

// 有本地代理时，Node 的 fetch 不读 HTTPS_PROXY，自动重启一次带上开关
if ((process.env.HTTPS_PROXY || process.env.https_proxy) && !process.env.NODE_USE_ENV_PROXY && !process.env.__MCD_REEXEC) {
  const r = spawnSync(process.execPath, process.argv.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, NODE_USE_ENV_PROXY: '1', __MCD_REEXEC: '1' },
  });
  process.exit(r.status ?? 0);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 4173);

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/plan' && req.method === 'POST') {
    try {
      const b = await readBody(req);
      const result = await runSaver({
        people: Number(b.people) || 1,
        budget: b.budget ? Number(b.budget) : null,
        budgetPerPerson: !!b.budgetPerPerson,
        avoid: Array.isArray(b.avoid) ? b.avoid : String(b.avoid || '').split(/[,，\s]+/).filter(Boolean),
        city: b.city || undefined,
        keyword: b.keyword || undefined,
        storeCode: b.storeCode || undefined,
        nutrition: !!b.nutrition,
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  const file = url.pathname === '/' ? '/web/index.html' : url.pathname;
  const full = path.join(ROOT, file);
  if (!full.startsWith(ROOT) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404); res.end('Not Found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
  res.end(fs.readFileSync(full));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`麦门省钱助手 → http://127.0.0.1:${PORT}`);
});
