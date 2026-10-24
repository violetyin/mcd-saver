// 历史订单：作为「个人基线」，看你自己过去怎么点
// 注意：新账号可能没有历史，必须优雅降级，不能影响主流程。

export function parseOrderList(res) {
  const d = res && typeof res === 'object' ? res.data || res : null;
  const list = Array.isArray(d?.list) ? d.list : [];
  return list.map((o) => ({
    orderId: o.orderId,
    time: o.createTime,
    store: o.storeName,
    status: o.orderStatus,
    amount: Number(o.realTotalAmount || 0), // 这个字段是「元」，不是分（实测 22.9 / 9.9 / 11）
    items: (o.orderProductList || []).map((p) => ({
      name: p.productName,
      quantity: p.quantity,
    })),
  }));
}

export function summarizeHistory(orders) {
  const valid = orders.filter((o) => !/取消/.test(o.status || ''));
  if (!orders.length) return null;
  const pool = valid.length ? valid : orders;
  const avg = pool.reduce((s, o) => s + o.amount, 0) / pool.length;
  const last = pool[0];
  return {
    count: orders.length,
    validCount: valid.length,
    avgAmount: Math.round(avg * 100) / 100,
    last: last
      ? {
          time: last.time,
          store: last.store,
          amount: last.amount,
          desc: last.items.map((i) => `${i.name}×${i.quantity}`).join(' + '),
        }
      : null,
    dishCount: pool.reduce((s, o) => s + o.items.reduce((a, i) => a + i.quantity, 0), 0),
  };
}

export async function fetchHistory(client) {
  try {
    const res = await client.call('order-list', {});
    const orders = parseOrderList(res);
    return { orders, summary: summarizeHistory(orders) };
  } catch {
    return { orders: [], summary: null };
  }
}
