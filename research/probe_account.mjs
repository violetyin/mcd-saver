import { McpClient, loadEnv } from '../src/mcp.mjs';
import path from 'node:path';
const env = loadEnv(path.resolve('.env'));
const c = new McpClient({ url:'https://mcp.mcd.cn', token: env.MCD_MCP_TOKEN });
await c.init();
for (const t of ['query-my-coupons','available-coupons','query-my-account']) {
  try {
    const r = await c.call(t, {});
    const s = typeof r?.data === 'string' ? r.data : JSON.stringify(r?.data);
    console.log('\n### '+t+' ('+(r?.code ?? '?')+')');
    console.log(s.slice(0, 900));
  } catch(e) { console.log('\n### '+t+' 失败: '+e.message.slice(0,120)); }
}
