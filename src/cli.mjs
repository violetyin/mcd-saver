#!/usr/bin/env node
// 命令行入口：node src/cli.mjs --people 2 --budget 100 --avoid 辣
import { spawnSync } from 'node:child_process';
import { runSaver, yuan } from './saver.mjs';

// 某些环境走本地代理，Node 的 fetch 默认不读 HTTPS_PROXY，这里自动重启一次带上开关
if ((process.env.HTTPS_PROXY || process.env.https_proxy) && !process.env.NODE_USE_ENV_PROXY && !process.env.__MCD_REEXEC) {
  const r = spawnSync(process.execPath, process.argv.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, NODE_USE_ENV_PROXY: '1', __MCD_REEXEC: '1' },
  });
  process.exit(r.status ?? 0);
}

function parseArgs(argv) {
  const out = { avoid: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--people' || a === '-p') out.people = Number(next());
    else if (a === '--budget' || a === '-b') out.budget = Number(next());
    else if (a === '--per-person') out.budgetPerPerson = true;
    else if (a === '--avoid') out.avoid = String(next()).split(/[,，\s]+/).filter(Boolean);
    else if (a === '--city') out.city = next();
    else if (a === '--keyword' || a === '-k') out.keyword = next();
    else if (a === '--store') out.storeCode = next();
    else if (a === '--nutrition') out.nutrition = true;
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`
麦门省钱助手 — 用麦当劳 MCP 算出一单最划算的组合

用法: node src/cli.mjs [选项]

  -p, --people <n>     用餐人数（默认 1）
  -b, --budget <n>     预算（默认不限制；单位：元）
      --per-person     预算按「每人」计算，而不是总价
      --avoid <词>     忌口，逗号分隔：辣 / 牛肉 / 鸡肉 / 猪肉 / 鱼 / 咖啡 / 冰
      --city <城市>    门店搜索城市（默认读 .env 的 MCD_CITY）
  -k, --keyword <词>   门店搜索关键词，商圈名最好用（默认读 MCD_KEYWORD）
      --store <code>   直接指定 storeCode，跳过门店搜索
      --nutrition      附带营养信息（多调一次接口）
      --json           输出结构化 JSON，便于接入 Skill / 网页
`);
  process.exit(0);
}

try {
  const r = await runSaver(args);
  if (args.json) {
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  }

  const line = '─'.repeat(58);
  console.log(`\n📍 ${r.store.storeName}${r.store.distance != null ? `（距离 ${r.store.distance}m）` : ''}`);
  console.log(`   门店编号 ${r.store.storeCode}｜到店自取`);
  console.log(`🥤 需求：${r.input.people} 人${r.input.budgetTotal ? ` · 预算 ¥${r.input.budgetTotal}` : ''}${r.input.avoid.length ? ` · 忌口 ${r.input.avoid.join('/')}` : ''}`);
  console.log(`🎟  可用券：${r.coupons.length} 张${r.coupons.length ? `（${r.coupons.map((c) => c.title).join('、')}）` : ''}`);
  if (r.baseline) {
    console.log(`📊 单点基线（${r.baseline.label}）：¥${yuan(r.baseline.price)}，人均 ¥${r.baseline.perPerson.toFixed(2)}`);
  }
  console.log(line);

  if (!r.plans.length) {
    console.log('❌ 预算内没有够吃的组合，建议放宽预算或去掉忌口限制。');
  }

  r.plans.forEach((p, i) => {
    const saved = p.original - p.price;
    const pct = p.original > 0 ? Math.round((saved / p.original) * 100) : 0;
    console.log(`\n方案 ${i + 1}｜${p.name}`);
    for (const it of p.items) {
      const cut = it.original > it.subtotal ? `（原价 ¥${yuan(it.original)}）` : '';
      console.log(`   · ${it.name} ×${it.quantity}   ¥${yuan(it.subtotal)}${cut}`);
    }
    let money = `   ── 实付 ¥${yuan(p.price)}（标价 ¥${yuan(p.original)}）`;
    if (saved > 0) money += `，券省 ¥${yuan(saved)}（${pct}%）`;
    money += `，人均 ¥${p.perPerson.toFixed(2)}`;
    console.log(money);
    if (p.savedVsBaseline != null) {
      const d = p.savedVsBaseline;
      console.log(d > 0
        ? `   ── 比一样样单点少花 ¥${yuan(d)}（${Math.round((d / r.baseline.price) * 100)}%）`
        : `   ── 比单点基线贵 ¥${yuan(-d)}`);
    }
    if (p.content) console.log(`   · 套餐默认含：${p.content.items.join(' + ')}`);
    if (p.nutrition) console.log(`   · 约 ${p.nutrition.kcal} 大卡 / 蛋白质 ${p.nutrition.protein}g / 脂肪 ${p.nutrition.fat}g（按餐品名匹配）`);
    console.log(`   · ${p.note}`);
  });

  if (r.alternatives.length) {
    console.log(`\n其他候选：`);
    for (const a of r.alternatives) console.log(`   · ${a.name} — 实付 ¥${yuan(a.price)}，人均 ¥${a.perPerson.toFixed(2)}`);
  }

  console.log(line);
  console.log(`🔎 本次真实调用麦当劳 MCP ${r.mcpCalls} 次（测了 ${r.candidatesTested} 种组合，${r.valid} 种有效）`);
  for (const l of r.log) console.log(`   · ${l}`);
  console.log(`\n⚠️ 金额均以 calculate-price 实时计算为准；不含下单动作。\n`);
} catch (e) {
  console.error(`\n❌ ${e.message}\n`);
  process.exit(1);
}
