import { McpClient, loadEnv } from '../src/mcp.mjs';
import path from 'node:path';
const env = loadEnv(path.resolve('.env'));
const c = new McpClient({ url:'https://mcp.mcd.cn', token: env.MCD_MCP_TOKEN });
await c.init();
// 只调用算价，不下单。看 create-order 需要的 takeWayCode 从哪来
const r = await c.call('calculate-price', {
  storeCode:'1960090', orderType:1, beType:1,
  items:[{ productCode:'9900015568', quantity:1 }],
});
const d = r.data || {};
console.log('takeWayList:', JSON.stringify(d.takeWayList, null, 1));
console.log('其他字段:', Object.keys(d).join(', '));
