// 网页版服务：零依赖 node:http，Token 只在服务端，前端永远拿不到
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runSaver } from '../src/saver.mjs';
import { walletSnapshot } from '../src/wallet.mjs';
import { McpClient, loadEnv } from '../src/mcp.mjs';
import { createOrder, cancelOrder } from '../src/order.mjs';

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

/** 每个请求单独建客户端：共享会话在并发时会被服务端掐掉 */
function makeClient() {
  const env = loadEnv(path.join(ROOT, '.env'));
  if (!env.MCD_MCP_TOKEN) throw new Error('缺少 MCD_MCP_TOKEN，请复制 .env.example 为 .env 并填入');
  return new McpClient({ url: 'https://mcp.mcd.cn', token: env.MCD_MCP_TOKEN });
}

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
  const json = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };

  // 券资产盘点
  if (url.pathname === '/api/wallet' && req.method === 'POST') {
    try {
      const client = makeClient();
      await client.init();
      const w = await walletSnapshot(client);
      json(200, { ...w, calls: client.calls });
    } catch (e) { json(500, { error: e.message }); }
    return;
  }

  // 一键领券（账户写操作，前端必须二次确认）
  if (url.pathname === '/api/claim' && req.method === 'POST') {
    try {
      const client = makeClient();
      await client.init();
      const before = await walletSnapshot(client);
      const claimRes = await client.call('auto-bind-coupons', {});
      const after = await walletSnapshot(client);
      json(200, {
        claimed: Math.max(0, after.mine.length - before.mine.length),
        before: before.mine.length,
        after: after.mine.length,
        raw: typeof claimRes === 'string' ? claimRes.slice(0, 400) : null,
        wallet: after,
        calls: client.calls,
      });
    } catch (e) { json(500, { error: e.message }); }
    return;
  }

  // 下单：会真实创建订单（未支付），付不付由用户决定
  if (url.pathname === '/api/order' && req.method === 'POST') {
    try {
      const b = await readBody(req);
      const client = makeClient();
      await client.init();
      const ways = Array.isArray(b.orders) ? b.orders : [];
      if (!ways.length) throw new Error('没有可下单的内容');

      const created = [];
      for (const order of ways) {
        const items = (order.items || []).map((i) => ({
          productCode: i.code || i.productCode,
          quantity: Number(i.quantity) || 1,
          ...(i.couponId ? { couponId: i.couponId, couponCode: i.couponCode } : {}),
        }));
        const r = await createOrder(client, {
          storeCode: b.storeCode,
          beType: 1,
          orderType: 1,
          takeWayCode: b.takeWayCode || 'eat-in',
          items,
          remark: b.remark,
        });
        created.push({ ...r, couponTitle: order.couponTitle || null });
      }
      json(200, { ok: true, orders: created, calls: client.calls });
    } catch (e) { json(500, { error: e.message }); }
    return;
  }

  // 取消订单
  if (url.pathname === '/api/cancel' && req.method === 'POST') {
    try {
      const b = await readBody(req);
      const client = makeClient();
      await client.init();
      const ids = Array.isArray(b.orderIds) ? b.orderIds : [b.orderId].filter(Boolean);
      const results = [];
      for (const id of ids) results.push(await cancelOrder(client, id, b.reason ?? -1));
      json(200, { results, calls: client.calls });
    } catch (e) { json(500, { error: e.message }); }
    return;
  }

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
      json(200, result);
    } catch (e) { json(500, { error: e.message }); }
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
