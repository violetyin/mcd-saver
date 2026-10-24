import { McpClient, loadEnv } from '../src/mcp.mjs';
import path from 'node:path';
const env = loadEnv(path.resolve('.env'));
const c = new McpClient({ url:'https://mcp.mcd.cn', token: env.MCD_MCP_TOKEN });
await c.init();
const base = { storeCode:'1960090', orderType:1, beType:1 };

// 挑一个便宜的、能单点的餐品
const menu = (await c.call('query-meals', base)).data;
const cands = Object.entries(menu.meals)
  .map(([code,m]) => ({ code, name: m.name, price: Number(m.currentPrice) }))
  .filter(x => x.price >= 4 && x.price <= 8 && !/酱|蘸|小料/.test(x.name))
  .sort((a,b)=>a.price-b.price);
const pick = cands[0];
console.log('选中:', pick);

const q = await c.call('calculate-price', { ...base, items:[{ productCode: pick.code, quantity: 1 }] });
const way = (q.data.takeWayList || [])[0];
console.log('取餐方式:', way, '| 算价:', q.data.price);

let orderId = null;
try {
  const r = await c.call('create-order', {
    ...base,
    takeWayCode: way.code,
    items: [{ productCode: pick.code, quantity: 1 }],
  });
  const d = r.data || r;
  orderId = d.orderId;
  console.log('\n=== 下单成功 ===');
  console.log('orderId:', orderId);
  console.log('payId:', d.payId);
  console.log('payH5Url:', String(d.payH5Url).slice(0, 160));
  console.log('订单摘要:', JSON.stringify({
    status: d.orderDetail?.orderStatus,
    total: d.orderDetail?.totalAmount,
    real: d.orderDetail?.realTotalAmount,
    store: d.orderDetail?.storeName,
    takeWay: JSON.stringify(d.orderDetail?.takeWay),
    pickupCode: d.orderDetail?.pickupCode,
  }));
} catch (e) {
  console.log('下单失败:', e.message.slice(0, 300));
}

if (orderId) {
  try {
    const cr = await c.call('cancel-order', { orderId, cancelReasonCode: -1 });
    console.log('\n=== 已取消 ===', JSON.stringify(cr.data || cr).slice(0,200));
    const check = await c.call('query-order', { orderId });
    console.log('复核状态:', check?.data?.orderStatus);
  } catch (e) {
    console.log('取消失败（需手工处理）:', e.message.slice(0,200));
  }
}
