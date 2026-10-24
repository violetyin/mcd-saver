import { McpClient, loadEnv } from '../src/mcp.mjs';
import path from 'node:path';
const env = loadEnv(path.resolve('.env'));
const c = new McpClient({ url:'https://mcp.mcd.cn', token: env.MCD_MCP_TOKEN });
await c.init();
try {
  const r = await c.call('order-list', {});
  const d = r?.data || r;
  const list = d?.list || [];
  console.log('历史订单数:', list.length);
  if (list.length) console.log('样本:', JSON.stringify(list[0]).slice(0,300));
} catch(e) { console.log('order-list 失败:', e.message.slice(0,120)); }

// 券能否在一单里用两次
const base = { storeCode:'1960090', orderType:1, beType:1 };
const coupon = { productCode:'9900004002', quantity:1, couponId:'B7A9CFE86AE99D8912FD0801A507FEC5', couponCode:'MCD61001000599271680H' };
for (const q of [1,2]) {
  try {
    const r = await c.call('calculate-price', { ...base, items: [{ ...coupon, quantity: q }] });
    const d = r.data||{};
    console.log(`券商品 ×${q} → price=${d.price} 原价=${d.originalPrice} 优惠=${d.discount}`);
  } catch(e){ console.log(`券商品 ×${q} 失败:`, e.message.slice(0,100)); }
}
