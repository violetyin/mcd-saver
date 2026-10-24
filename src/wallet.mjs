// 账户券资产盘点
// 注意：query-my-coupons 和 available-coupons 返回的是 markdown，不是 JSON，必须单独解析。
import { extractJson } from './mcp.mjs';

/** 解析「我的优惠券」markdown */
export function parseMyCoupons(md) {
  if (typeof md !== 'string') return [];
  const blocks = md.split(/^## /m).slice(1);
  const out = [];
  for (const b of blocks) {
    const name = (b.split(/\r?\n/)[0] || '').trim();
    if (!name) continue;
    const price = (b.match(/\*\*优惠\*\*[:：]\s*¥?\s*([\d.]+)/) || [])[1];
    const valid = (b.match(/\*\*有效期\*\*[:：]\s*([^\n]+)/) || [])[1];
    const tags = (b.match(/\*\*标签\*\*[:：]\s*([^\n]+)/) || [])[1];
    let endDate = null;
    if (valid) {
      const m = valid.match(/(\d{4}-\d{2}-\d{2})\s*(\d{2}:\d{2})?\s*$/);
      const all = valid.match(/\d{4}-\d{2}-\d{2}/g);
      endDate = m ? m[0].slice(0, 10) : all ? all[all.length - 1] : null;
    }
    out.push({
      name,
      price: price ? Number(price) : null,
      valid: valid ? valid.trim() : null,
      tags: tags ? tags.trim() : null,
      endDate,
      daysLeft: endDate ? Math.ceil((new Date(endDate + 'T23:59:59') - Date.now()) / 86400000) : null,
    });
  }
  return out;
}

/** 解析「麦麦省可领券」markdown
 *  只保留真正还能领的：status 必须是「可领取」。
 *  注意「不可领取」里也含「可领取」三个字，必须整串相等，不能用 includes。
 */
export function parseAvailableCoupons(md) {
  if (typeof md !== 'string') return [];
  const titles = [...md.matchAll(/优惠券标题[:：]\s*([^\n\\]+)/g)].map((m) => m[1].trim());
  const status = [...md.matchAll(/状态[:：]\s*([^\n\\]+)/g)].map((m) => m[1].trim());
  return titles
    .map((t, i) => ({ title: t, status: (status[i] || '').trim() }))
    .filter((x) => x.title && x.status === '可领取');
}

/** 解析「我的积分」 */
export function parseAccount(res) {
  const d = res && typeof res === 'object' ? res.data || res : null;
  if (!d || d.availablePoint === undefined) return null;
  return {
    available: Number(d.availablePoint || 0),
    total: Number(d.accumulativePoint || 0),
    expired: Number(d.expiredPoint || 0),
    expiringThisMonth: Number(d.currentMouthExpirePoint || 0),
    used: Number(d.usedPoint || 0),
  };
}

/** 一次性拉取账户券资产 */
export async function walletSnapshot(client) {
  const errors = [];
  const safe = async (tool, args = {}) => {
    try { return await client.call(tool, args); }
    catch (e) { errors.push(`${tool}: ${String(e.message).slice(0, 60)}`); return null; }
  };

  const [mineRes, availRes, accRes] = await (async () => {
    const a = await safe('query-my-coupons');
    const b = await safe('available-coupons');
    const c = await safe('query-my-account');
    return [a, b, c];
  })();

  const mine = parseMyCoupons(mineRes);
  const claimable = parseAvailableCoupons(availRes);
  const account = parseAccount(accRes);

  return {
    mine,
    claimable,
    account,
    errors,
    expiringSoon: mine.filter((c) => c.daysLeft !== null && c.daysLeft <= 7),
  };
}

/** 文本化 */
export function formatWallet(w, yuan = (n) => Number(n).toFixed(2)) {
  const L = [];
  L.push(`已持有券 ${w.mine.length} 张`);
  for (const c of w.mine) {
    const p = c.price != null ? `¥${yuan(c.price)}` : '—';
    const d = c.daysLeft != null ? `，${c.daysLeft} 天后过期` : '';
    L.push(`   · ${c.name}（${p}${d}）${c.tags ? ' · ' + c.tags : ''}`);
  }
  L.push(`麦麦省可领未领 ${w.claimable.length} 张`);
  for (const c of w.claimable) L.push(`   · ${c.title}（${c.status || '可领取'}）`);
  if (w.account) {
    L.push(`积分：可用 ${w.account.available}，已过期 ${w.account.expired}，本月将过期 ${w.account.expiringThisMonth}`);
  }
  return L.join('\n');
}
