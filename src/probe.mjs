// 探针脚本：只用来摸清真实字段与单位，跑一次即可
import fs from 'node:fs';
import { McpClient, loadEnv } from './mcp.mjs';

const env = loadEnv();
const save = (name, data) => {
  fs.mkdirSync('out', { recursive: true });
  fs.writeFileSync(`out/${name}.json`, JSON.stringify(data, null, 2));
};
const show = (label, v) => console.log(label, JSON.stringify(v).slice(0, 600));

const client = new McpClient({ url: 'https://mcp.mcd.cn', token: env.MCD_MCP_TOKEN });
const info = await client.init();
console.log('握手:', info?.serverInfo);

const stores = await client.call('query-nearby-stores', {
  beType: 1,
  searchType: 2,
  city: env.MCD_CITY || '北京',
  keyword: env.MCD_KEYWORD || '国贸',
});
save('stores', stores);
const list = Array.isArray(stores?.data) ? stores.data : [];
console.log('\n门店条数:', Array.isArray(list) ? list.length : typeof list);
if (Array.isArray(list) && list.length) show('第1家:', list[0]);

const s0 = list[0];
if (!s0) { console.log('没查到门店，换关键词'); process.exit(0); }

const base = { storeCode: String(s0.storeCode), orderType: 1, beType: 1 };
const meals = await client.call('query-meals', base);
save('meals', meals);
const m = meals?.data || {};
console.log('\nquery-meals 顶层键:', Object.keys(m));
console.log('frequent:', (m.frequent || []).length, 'categories:', (m.categories || []).length, 'meals:', Object.keys(m.meals || {}).length);
const firstCat = (m.categories || [])[0];
if (firstCat) console.log('类目示例:', firstCat.name, '餐品数', (firstCat.meals || []).length, '首项', JSON.stringify(firstCat.meals?.[0]));
const mealCodes = Object.keys(m.meals || {}).slice(0, 3);
for (const c of mealCodes) console.log('餐品', c, '→', JSON.stringify(m.meals[c]).slice(0, 300));

const coupons = await client.call('query-store-coupons', base);
save('coupons', coupons);
console.log('\n券:', JSON.stringify(coupons?.data).slice(0, 500));

const pick = (m.categories || []).flatMap((c) => (c.meals || []).map((x) => x.code)).slice(0, 2);
if (pick.length) {
  const priced = await client.call('calculate-price', {
    ...base,
    items: pick.map((code) => ({ productCode: code, quantity: 1 })),
  });
  save('price', priced);
  const d = priced?.data || {};
  console.log('\ncalculate-price 键:', Object.keys(d));
  console.log('金额:', JSON.stringify({
    price: d.price, originalPrice: d.originalPrice, discount: d.discount,
    productPrice: d.productPrice, productOriginalPrice: d.productOriginalPrice,
  }));
}

const nut = await client.call('list-nutrition-foods', {});
save('nutrition', nut);
console.log('\n营养原始返回类型:', typeof nut?.data);
console.log(String(nut?.data).slice(0, 400));
console.log('\n累计 MCP 调用次数:', client.calls);
