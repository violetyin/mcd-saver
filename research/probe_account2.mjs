import { McpClient, loadEnv } from '../src/mcp.mjs';
import path from 'node:path';
const env = loadEnv(path.resolve('.env'));
const c = new McpClient({ url:'https://mcp.mcd.cn', token: env.MCD_MCP_TOKEN });
await c.init();
for (const t of ['query-my-coupons','available-coupons']) {
  const r = await c.call(t, {});
  console.log('\n### '+t+' 类型='+(typeof r));
  console.log(String(typeof r === 'string' ? r : JSON.stringify(r)).slice(0, 1200));
}
