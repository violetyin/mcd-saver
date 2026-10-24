// 麦门省钱助手 · 决策引擎
// 核心原则：一切金额以 calculate-price 返回值为准（单位：分），绝不用标价相加。
import { McpClient, loadEnv } from './mcp.mjs';
import { parseToon, matchNutrition } from './toon.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 无论从哪个目录启动，都读项目根目录的 .env
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const MCD_URL = 'https://mcp.mcd.cn';

// ---------- 类目 → 角色 ----------
const ROLE_RULES = [
  ['multi',  /多人餐|拼盘|分享/],
  ['single', /单人餐|大堡口福|大卡套餐|随心配|1\+1/],
  ['main',   /汉堡|牛堡|厚牛堡|巨无霸|\/卷|卷$/],
  ['side',   /小食|甜品|炸鸡|薯条/],
  ['drink',  /饮品|麦咖啡|饮料/],
];
const ROLE_ORDER = ['multi', 'single', 'main', 'side', 'drink'];
const ROLE_LABEL = { multi: '多人餐', single: '单人套餐', main: '主食汉堡', side: '小食', drink: '饮品' };

function roleOf(categoryName) {
  for (const [role, re] of ROLE_RULES) if (re.test(categoryName)) return role;
  return null;
}

const yuan = (fen) => (Number(fen || 0) / 100).toFixed(2);

/** 把菜单整理成「按角色分桶、桶内按价格升序」的结构，并去重 */
function buildRoleBuckets(menuData) {
  const meals = menuData.meals || {};
  const buckets = Object.fromEntries(ROLE_ORDER.map((r) => [r, []]));
  const seen = new Set();

  const cats = (menuData.categories || [])
    .map((c) => ({ ...c, role: roleOf(c.name || '') }))
    .filter((c) => c.role)
    .sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));

  for (const cat of cats) {
    for (const ref of cat.meals || []) {
      const code = ref.code;
      if (!code || seen.has(code)) continue;
      const m = meals[code];
      if (!m) continue;
      const price = Number(m.currentPrice);
      if (!Number.isFinite(price)) continue;
      seen.add(code);
      buckets[cat.role].push({
        code,
        name: m.name,
        price,
        originalPrice: Number(m.originalPrice ?? m.currentPrice),
        onSale: Number(m.originalPrice ?? 0) > price,
        category: (cat.name || '').replace(/\s+/g, ''),
        tags: ref.tags || [],
      });
    }
  }
  for (const r of ROLE_ORDER) {
    let list = buckets[r];
    // 蘸酱、加价购小料不是真的「一份小食」，会拉低人均造成误导
    if (r === 'side') list = list.filter((x) => x.price >= 5 && !/酱|蘸|小料/.test(x.name));
    if (r === 'drink') list = list.filter((x) => x.price >= 5);
    buckets[r] = list.sort((a, b) => a.price - b.price);
  }
  return buckets;
}

/** 忌口/口味过滤：只看餐品名，属于启发式，结果里会明确标注 */
function makeFilter(avoid) {
  const rules = {
    辣: /辣|椒麻|藤椒/,
    牛肉: /牛|安格斯|巨无霸/,
    鸡肉: /鸡/,
    猪肉: /猪|培根|扒/,
    鱼: /鱼/,
    咖啡: /咖啡|拿铁|美式|澳白/,
    冰: /冰/,
  };
  const res = (avoid || []).map((k) => rules[k]).filter(Boolean);
  return (item) => !res.some((re) => re.test(item.name || ''));
}

/** 从桶里按「便宜优先」取前 n 个，并夹一个中位价位做多样性 */
function picks(bucket, n = 2) {
  if (!bucket.length) return [];
  const out = bucket.slice(0, n);
  if (bucket.length > n + 2) out.push(bucket[Math.floor(bucket.length / 2)]);
  return out;
}

// ---------- 候选组合 ----------
function buildCandidates({ people, buckets, coupons, filter }) {
  const pick = (role) => (buckets[role] || []).filter(filter);
  const cands = [];
  // covers = 这套能供几个人吃，用于算人均，避免「一份券」被当成两人餐
  const add = (name, kind, items, note, covers) => cands.push({ name, kind, items, note, covers });

  const cheapMain = pick('main')[0] || pick('single')[0];

  // 1) 用券：券本身就是最狠的省钱方式，必须优先
  for (const cp of coupons.slice(0, 4)) {
    const p = (cp.products || [])[0];
    if (!p?.productCode) continue;
    const menuHit = Object.values(buckets).flat().find((x) => x.code === p.productCode);
    if (menuHit && !filter(menuHit)) continue;
    const couponItem = { code: p.productCode, quantity: 1, couponId: cp.couponId, couponCode: cp.couponCode };
    const vaild = `券有效期 ${cp.tradeDateTime || '见券面'}`;
    if (people === 1 || !cheapMain) {
      add(`用券：${cp.title}`, 'coupon', [couponItem], vaild, 1);
    } else {
      add(`用券：${cp.title} + ${cheapMain.name}×${people - 1}`, 'coupon',
        [couponItem, { code: cheapMain.code, quantity: people - 1 }], `${vaild}；券限 1 份，其余单点`, people);
    }
  }

  // 2) 单人套餐 × 人数
  for (const s of picks(pick('single'), 2)) {
    add(`${s.name} ×${people}`, 'single', [{ code: s.code, quantity: people }], '自带主食+小食/饮品', people);
  }

  // 3) 多人餐（按 2 人份一盒折算，凑够人数）
  if (people >= 2) {
    const share = Math.ceil(people / 2);
    for (const m of picks(pick('multi'), 2)) {
      add(`${m.name} ×${share}`, 'multi', [{ code: m.code, quantity: share }], `多人分享装，约 ${share * 2} 人份`, share * 2);
    }
  }

  // 4) 自由组合：主食 + 小食 + 饮品
  const mains = picks(pick('main'), 2);
  const sides = picks(pick('side'), 1);
  const drinks = picks(pick('drink'), 1);
  for (const main of mains) {
    if (drinks.length) {
      add(`${main.name}×${people} + ${drinks[0].name}×${people}`, 'combo',
        [{ code: main.code, quantity: people }, { code: drinks[0].code, quantity: people }], '汉堡+饮品，够饱也够省', people);
    }
    if (sides.length) {
      add(`${main.name}×${people} + ${sides[0].name}×${people}`, 'combo',
        [{ code: main.code, quantity: people }, { code: sides[0].code, quantity: people }], '汉堡+小食', people);
    }
    if (sides.length && drinks.length) {
      add(`${main.name}×${people} + ${sides[0].name}×${people} + ${drinks[0].name}×${people}`, 'full',
        [{ code: main.code, quantity: people }, { code: sides[0].code, quantity: people }, { code: drinks[0].code, quantity: people }],
        '完整一套，主食+小食+饮品', people);
    }
  }

  return cands.slice(0, 18); // 控制调用次数，避免演示时超时
}

// ---------- 主流程 ----------
export async function runSaver(opts) {
  const env = loadEnv(path.join(ROOT, '.env'));
  const token = opts.token || env.MCD_MCP_TOKEN;
  if (!token) throw new Error('缺少 MCD_MCP_TOKEN，请复制 .env.example 为 .env 并填入 Token');

  const people = Math.max(1, Number(opts.people || 1));
  const budgetTotal = opts.budget ? Number(opts.budget) * (opts.budgetPerPerson ? people : 1) : null;
  const client = new McpClient({ url: MCD_URL, token });
  const log = [];
  const step = (msg) => log.push(msg);

  await client.init();
  step('initialize 握手成功（mcd-mcp 1.0.0）');

  // 1. 定门店（beType=1 到店自取：不传 beCode，传了会报错）
  let stores = [];
  if (opts.storeCode) {
    stores = [{ storeCode: String(opts.storeCode), storeName: opts.storeName || `门店 ${opts.storeCode}` }];
  } else {
    const r = await client.call('query-nearby-stores', {
      beType: 1, searchType: 2, city: opts.city || env.MCD_CITY || '北京', keyword: opts.keyword || env.MCD_KEYWORD || '国贸',
    });
    stores = Array.isArray(r?.data) ? r.data : [];
    if (!stores.length) {
      const fav = await client.call('query-nearby-stores', { beType: 1, searchType: 1 });
      stores = Array.isArray(fav?.data) ? fav.data : [];
    }
    step(`query-nearby-stores → ${stores.length} 家门店`);
  }
  const store = stores[0];
  if (!store) throw new Error('没找到门店，换个 --keyword（例如商圈名）再试');
  if (store.businessStatus === false) step(`⚠️ ${store.storeName} 当前显示非营业（${store.businessStartTime}-${store.businessEndTime}）`);

  const base = { storeCode: String(store.storeCode), orderType: 1, beType: 1 };

  // 2. 菜单 + 本店券 + 营养（串行：并发请求这个服务偶发失败）
  const menuRes = await client.call('query-meals', base);
  const menu = menuRes?.data || {};
  step(`query-meals → ${Object.keys(menu.meals || {}).length} 个餐品 / ${(menu.categories || []).length} 个类目`);

  let coupons = [];
  try {
    const couponRes = await client.call('query-store-coupons', base);
    coupons = Array.isArray(couponRes?.data) ? couponRes.data : [];
    step(`query-store-coupons → ${coupons.length} 张可用券`);
  } catch (e) {
    step(`⚠️ query-store-coupons 失败（按无券继续）：${String(e.message).slice(0, 80)}`);
  }

  let nutRes = null;
  if (opts.nutrition) {
    try { nutRes = await client.call('list-nutrition-foods', {}); }
    catch (e) { step(`⚠️ list-nutrition-foods 失败：${String(e.message).slice(0, 60)}`); }
  }

  const buckets = buildRoleBuckets(menu);
  const filter = makeFilter(opts.avoid);
  const cands = buildCandidates({ people, buckets, coupons, filter });

  // 单点基线：每人「一份主食 + 一份小食 + 一杯饮品」全部分开单点要多少钱
  // 这是「省钱」的参照物——套餐/券方案比它少付多少，才是真的省
  let baseline = null;
  {
    const bMain = (buckets.main || []).filter(filter)[0];
    const bSide = (buckets.side || []).filter(filter)[0];
    const bDrink = (buckets.drink || []).filter(filter)[0];
    if (bMain) {
      const parts = [bMain, bSide, bDrink].filter(Boolean);
      try {
        const r = await client.call('calculate-price', {
          ...base,
          items: parts.map((p) => ({ productCode: p.code, quantity: people })),
        });
        const d = r?.data || {};
        if (Number(d.price) > 0) {
          baseline = {
            price: Number(d.price),
            perPerson: Math.round(Number(d.price) / people) / 100,
            label: parts.map((p) => `${p.name}×${people}`).join(' + '),
            items: parts.map((p) => p.name),
          };
          step(`单点基线 → ${parts.map((p) => p.name).join(' + ')} = ¥${yuan(baseline.price)}`);
        }
      } catch { /* 基线失败不影响主流程 */ }
    }
  }

  // 3. 逐个算实付价（唯一可信金额来源）
  const priced = [];
  for (const cand of cands) {
    try {
      const r = await client.call('calculate-price', {
        ...base,
        items: cand.items.map((i) => ({
          productCode: i.code,
          quantity: i.quantity,
          ...(i.couponId ? { couponId: i.couponId, couponCode: i.couponCode } : {}),
        })),
      });
      const d = r?.data || {};
      const price = Number(d.price);
      const original = Number(d.originalPrice || d.price);
      // 券商品不带券会返回 0，必须当作无效，否则会被排成「最便宜」
      if (!Number.isFinite(price) || price <= 0) continue;
      const items = (d.productList || []).map((p) => ({
        name: p.productName, quantity: p.quantity,
        subtotal: Number(p.subtotal), original: Number(p.originalSubtotal ?? p.subtotal),
      }));
      priced.push({
        ...cand, price, original,
        discount: Number(d.discount || 0),
        perPerson: Math.round(price / Math.max(1, cand.covers)) / 100,
        savedVsBaseline: baseline ? baseline.price - price : null,
        rawItems: cand.items,
        items,
      });
    } catch (e) {
      step(`⚠️ ${cand.name} 算价失败：${String(e.message).slice(0, 80)}`);
    }
  }
  step(`calculate-price → 有效组合 ${priced.length} 个（已剔除 price=0 的异常返回）`);

  // 4. 先保证够吃，再卡预算，最后按人均实付升序
  const enough = priced.filter((p) => p.covers >= people);
  const inBudget = budgetTotal ? enough.filter((p) => p.price <= budgetTotal * 100) : enough;
  inBudget.sort((a, b) => a.perPerson - b.perPerson);
  const top = inBudget.slice(0, 3);

  // 3.5 给前三个方案补「套餐里到底有什么」——默认选中的那几项
  for (const plan of top) {
    if (plan.kind === 'coupon') continue; // 券商品的详情不可靠，不展示构成
    const first = plan.rawItems.find((it) => menu.meals?.[it.code]) || plan.rawItems[0];
    if (!first) continue;
    try {
      const d = await client.call('query-meal-detail', { ...base, code: first.code });
      const rounds = d?.data?.rounds || [];
      if (!rounds.length) continue;
      const picks2 = [];
      for (const rd of rounds) {
        const chosen = (rd.choices || []).filter((c) => Number(c.isDefault) === 1 || c.quantity > 0);
        for (const c of chosen) picks2.push(c.name);
      }
      if (picks2.length) plan.content = { of: d.data.name, items: [...new Set(picks2)] };
    } catch { /* 明细失败不影响主结果 */ }
  }
  step(`query-meal-detail → 已补齐前 ${top.filter((t) => t.content).length} 个方案的套餐构成`);

  // 5. 营养（可选加分项）
  if (nutRes) {
    const rows = parseToon(typeof nutRes?.data === 'string' ? nutRes.data : '');
    for (const t of priced) {
      let kcal = 0, fat = 0, protein = 0, matched = 0;
      // 套餐就按默认构成里的真实餐品算，比按套餐名猜准得多
      const names = t.content?.items?.length ? t.content.items : t.items.map((i) => i.name);
      for (const name of names) {
        const n = matchNutrition(rows, name);
        if (n?.kcal) { kcal += n.kcal; fat += n.fat || 0; protein += n.protein || 0; matched++; }
      }
      t.nutrition = matched ? { kcal: Math.round(kcal), fat: Math.round(fat), protein: Math.round(protein), matched, total: names.length } : null;
    }
    step(`list-nutrition-foods → 营养表 ${rows.length} 条（TOON 格式已解析）`);
  }

  return {
    store: { storeCode: String(store.storeCode), storeName: store.storeName, address: store.address, distance: store.distance },
    input: { people, budgetTotal, avoid: opts.avoid || [], city: opts.city, keyword: opts.keyword },
    coupons: coupons.map((c) => ({ title: c.title, couponId: c.couponId, valid: c.tradeDateTime })),
    candidatesTested: cands.length,
    valid: priced.length,
    baseline,
    plans: top,
    alternatives: inBudget.slice(3, 6),
    mcpCalls: client.calls,
    log,
  };
}

export { yuan };
