// 麦门省钱助手 · 决策引擎
// 核心原则：一切金额以 calculate-price 返回值为准（单位：分），绝不用标价相加。
import { McpClient, loadEnv } from './mcp.mjs';
import { parseToon } from './toon.mjs';
import { perPerson, sameBasket, nutritionForComponents } from './recommendation.mjs';
import { walletSnapshot } from './wallet.mjs';
import { fetchHistory } from './history.mjs';
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

// ---------- 拆单候选 ----------
// 实测结论：一单只能核销一张券，券商品 quantity=2 时价格不变（第 2 份白买）。
// 所以「多张券」的唯一用尽方式是把餐拆成多笔订单，每人一单。
function buildSplitCandidates({ people, buckets, coupons, filter }) {
  if (coupons.length < 2 || people < 2) return [];
  const cheapMain = (buckets.main || []).filter(filter)[0];

  // 每张券优先给一个人用；券比人多的，多出来的券这一顿用不上
  const use = coupons.slice(0, people);
  const orders = [];
  for (const cp of use) {
    const p = (cp.products || [])[0];
    if (!p?.productCode) continue;
    const hit = Object.values(buckets).flat().find((x) => x.code === p.productCode);
    if (hit && !filter(hit)) continue;
    orders.push({
      couponTitle: cp.title,
      items: [{ code: p.productCode, quantity: 1, couponId: cp.couponId, couponCode: cp.couponCode }],
    });
  }
  if (orders.length < 2) return [];

  // 券不够覆盖所有人时，剩下的人补一单常规主食
  const short = people - orders.length;
  if (short > 0 && cheapMain) {
    orders.push({ couponTitle: null, items: [{ code: cheapMain.code, quantity: short }] });
  }

  return [{
    name: `拆单：${orders.filter((o) => o.couponTitle).length} 张券分 ${orders.length} 单下`,
    kind: 'split',
    orders,
    items: [],
    covers: people,
    note: `一单只能核销一张券，拆开才能把 ${orders.filter((o) => o.couponTitle).length} 张券都用上`,
  }];
}

// ---------- 主流程 ----------
export async function runSaver(opts) {
  const env = loadEnv(path.join(ROOT, '.env'));
  const token = opts.token || env.MCD_MCP_TOKEN;
  if (!token && !opts.client) throw new Error('缺少 MCD_MCP_TOKEN，请复制 .env.example 为 .env 并填入 Token');

  const people = Math.max(1, Number(opts.people || 1));
  const budgetTotal = opts.budget ? Number(opts.budget) * (opts.budgetPerPerson ? people : 1) : null;
  const client = opts.client || new McpClient({ url: MCD_URL, token });
  const log = [];
  const step = (msg) => log.push(msg);

  await client.init();
  step('initialize 握手成功（mcd-mcp 1.0.0）');

  // 1. 定门店（beType=1 到店自取：不传 beCode，传了会报错）
  let stores = [];
  if (opts.storeCode) {
    stores = [{
      storeCode: String(opts.storeCode),
      storeName: opts.storeName || `门店 ${opts.storeCode}`,
      address: opts.storeAddress || null,
      distance: opts.storeDistance ?? null,
    }];
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

  // 1.5 账户券资产盘点（这是整条链的起点：先看手里有什么，再看菜单）
  let wallet = await walletSnapshot(client);
  step(`券资产 → 持有 ${wallet.mine.length} 张、可领未领 ${wallet.claimable.length} 张${wallet.account ? `、积分已过期 ${wallet.account.expired}` : ''}`);

  // 可选：先领券再算（账户写操作，必须由用户显式开启）
  if (opts.claim && wallet.claimable.length) {    try {
      await client.call('auto-bind-coupons', {});
      step(`auto-bind-coupons → 已领取麦麦省券，重新盘点`);
      wallet = await walletSnapshot(client);
      step(`领后持有 ${wallet.mine.length} 张、剩余可领 ${wallet.claimable.length} 张`);
    } catch (e) {
      step(`⚠️ 领券失败（按原券池继续）：${String(e.message).slice(0, 70)}`);
    }
  }

  // 1.6 历史订单（个人基线，没有就降级，不影响主流程）
  const history = await fetchHistory(client);
  if (history.summary) {
    step(`order-list → 历史 ${history.summary.count} 笔，有效 ${history.summary.validCount} 笔，单均 ¥${history.summary.avgAmount}`);
  } else {
    step(`order-list → 无历史订单（本轮用标准基线）`);
  }

  // 2. 菜单 + 本店券 + 营养（串行：并发请求这个服务偶发失败）
  const menuRes = await client.call('query-meals', base);
  const menu = menuRes?.data || {};
  step(`query-meals → ${Object.keys(menu.meals || {}).length} 个餐品 / ${(menu.categories || []).length} 个类目`);

  let coupons = [];
  let couponLookupFailed = false;
  try {
    const couponRes = await client.call('query-store-coupons', base);
    coupons = Array.isArray(couponRes?.data) ? couponRes.data : [];
    step(`query-store-coupons → ${coupons.length} 张可用券`);
  } catch (e) {
    couponLookupFailed = true;
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
  const splitCands = buildSplitCandidates({ people, buckets, coupons, filter });
  const allCands = [...cands, ...splitCands];

  // 单点参考餐：仅在商品和份数完全相同时才计算「比单点省」。
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
            rawItems: parts.map((p) => ({ code: p.code, quantity: people })),
          };
          step(`单点基线 → ${parts.map((p) => p.name).join(' + ')} = ¥${yuan(baseline.price)}`);
        }
      } catch { /* 基线失败不影响主流程 */ }
    }
  }

  // 3. 逐个算实付价（唯一可信金额来源）
  const priceItems = async (items) => {
    const r = await client.call('calculate-price', {
      ...base,
      items: items.map((i) => ({
        productCode: i.code,
        quantity: i.quantity,
        ...(i.couponId ? { couponId: i.couponId, couponCode: i.couponCode } : {}),
      })),
    });
    const d = r?.data || {};
    return {
      price: Number(d.price),
      original: Number(d.originalPrice || d.price),
      discount: Number(d.discount || 0),
      productList: (d.productList || []).map((p) => ({
        name: p.productName,
        quantity: p.quantity,
        subtotal: Number(p.subtotal),
        original: Number(p.originalSubtotal ?? p.subtotal),
      })),
    };
  };

  const priced = [];
  for (const cand of allCands) {
    try {
      // 拆单：每笔订单单独算价，再汇总（因为一单只能核销一张券）
      if (cand.kind === 'split') {
        let price = 0, original = 0, discount = 0;
        const detail = [];
        let bad = false;
        for (const o of cand.orders) {
          const r = await priceItems(o.items);
          if (!Number.isFinite(r.price) || r.price <= 0) { bad = true; break; }
          price += r.price; original += r.original; discount += r.discount;
          detail.push({ couponTitle: o.couponTitle, price: r.price, items: r.productList });
        }
        if (bad) continue;
        priced.push({
          ...cand, price, original, discount, ordersDetail: detail, rawOrders: cand.orders,
          perPerson: perPerson(price, people),
          savedVsBaseline: null,
          rawItems: [],
          items: detail.flatMap((d) => d.items),
        });
        continue;
      }

      const r = await priceItems(cand.items);
      // 券商品不带券会返回 0，必须当作无效，否则会被排成「最便宜」
      if (!Number.isFinite(r.price) || r.price <= 0) continue;
      priced.push({
        ...cand, price: r.price, original: r.original, discount: r.discount,
        perPerson: perPerson(r.price, people),
        savedVsBaseline: baseline && sameBasket(cand.items, baseline.rawItems) ? baseline.price - r.price : null,
        rawItems: cand.items,
        items: r.productList,
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

  // 展开前三个方案的每份套餐：拿到「这套里到底有哪些单品」，用于营养和同餐品比价
  const roleByCode = new Map(Object.entries(buckets).flatMap(([role, list]) => list.map((item) => [item.code, role])));
  const nameToCode = new Map();
  for (const [code, m] of Object.entries(menu.meals || {})) {
    if (m?.name) nameToCode.set(String(m.name).replace(/\s/g, ''), code);
  }
  const resolveCode = (name) => {
    const k = String(name || '').replace(/\s/g, '');
    if (nameToCode.has(k)) return nameToCode.get(k);
    const hit = [...nameToCode.entries()].find(([n]) => n.includes(k) || k.includes(n));
    return hit ? hit[1] : null;
  };

  const detailCache = new Map();
  const planComponents = new Map(); // plan -> { list: [{code,name,quantity}], complete }
  for (const plan of top) {
    if (plan.kind === 'coupon' || plan.kind === 'split') continue; // 券餐构成未核实，不报热量
    const components = [];
    let complete = true;
    for (const item of plan.rawItems) {
      const quantity = Number(item.quantity);
      const role = roleByCode.get(item.code);
      if (!Number.isFinite(quantity) || quantity <= 0) { complete = false; break; }
      if (role !== 'single' && role !== 'multi') {
        const name = menu.meals?.[item.code]?.name;
        if (!name) { complete = false; break; }
        components.push({ code: item.code, name, quantity });
        continue;
      }
      if (!detailCache.has(item.code)) {
        try {
          const d = await client.call('query-meal-detail', { ...base, code: item.code });
          detailCache.set(item.code, d?.data || null);
        } catch { detailCache.set(item.code, null); }
      }
      const detail = detailCache.get(item.code);
      const rounds = detail?.rounds || [];
      if (!rounds.length) { complete = false; break; }
      // 每一轮是「从这些选项里选 N 个」，不能把 hasDefault 和 quantity>0 的选项同时算进去
      // 实测：粉区里「怡泉+C麦炫酷」标了默认但 quantity=0，真正选中的是 quantity=1 的「阳光柠檬红茶」
      const picked = [];
      let roundOk = true;
      for (const rd of rounds) {
        const choices = rd.choices || [];
        const selected = choices.filter((c) => Number(c.quantity) > 0);
        const chosen = selected.length
          ? selected
          : choices.filter((c) => Number(c.isDefault) === 1).slice(0, Number(rd.quantity) || 1);
        if (!chosen.length) { roundOk = false; break; }
        for (const c of chosen) {
          picked.push({ name: c.name, code: resolveCode(c.name), perSet: Number(c.quantity) > 0 ? Number(c.quantity) : 1 });
        }
      }
      if (!roundOk) { complete = false; break; }
      const parts = picked.map((p) => ({ name: p.name, code: p.code, quantity: quantity * p.perSet }));
      components.push(...parts);
      plan.content = { of: detail.name, items: parts.map((part) => part.name) };
    }
    if (components.length) planComponents.set(plan, { list: components, complete });
  }
  step(`query-meal-detail → 已补齐前 ${top.filter((t) => t.content).length} 个方案的套餐构成`);

  // 4.5 同餐品单点价：把套餐里的单品分别买一次，看套餐到底便宜多少。
  // 这是唯一站得住的「省多少」——商品完全相同，只有打包方式不同。
  for (const plan of top) {
    const comp = planComponents.get(plan);
    if (!comp || !comp.complete) continue;
    const items = comp.list.filter((c) => c.code && c.quantity > 0).map((c) => ({ code: c.code, quantity: c.quantity }));
    if (items.length !== comp.list.length) continue; // 有单品在菜单里找不到，不硬算
    try {
      const r = await priceItems(items);
      if (!Number.isFinite(r.price) || r.price <= 0) continue;
      plan.sameItems = {
        price: r.price,          // 同样这些吃的、分开单点各一份的总价（分）
        saved: r.price - plan.price,
        pct: r.price > 0 ? Math.round(((r.price - plan.price) / r.price) * 100) : 0,
        items: items.length,
      };
    } catch { /* 算不出就不展示，不影响主结果 */ }
  }
  step(`同餐品单点价比价 → ${top.filter((t) => t.sameItems).length} 个方案可比`);

  // 5. 营养（可选加分项）
  if (nutRes) {
    const rows = parseToon(typeof nutRes?.data === 'string' ? nutRes.data : '');
    for (const t of top) {
      const comp = planComponents.get(t);
      t.nutrition = nutritionForComponents(rows, comp?.list);
    }
    step(`list-nutrition-foods → 营养表 ${rows.length} 条（TOON 格式已解析）`);
  }

  return {
    store: { storeCode: String(store.storeCode), storeName: store.storeName, address: store.address, distance: store.distance },
    input: { people, budgetTotal, avoid: opts.avoid || [], city: opts.city, keyword: opts.keyword },
    coupons: coupons.map((c) => ({ title: c.title, couponId: c.couponId, valid: c.tradeDateTime })),
    couponLookupFailed,
    candidatesTested: allCands.length,
    valid: priced.length,
    baseline,
    wallet,
    history,
    plans: top,
    alternatives: inBudget.slice(3, 6),
    mcpCalls: client.calls,
    log,
  };
}

export { yuan };
