// 下单与取消
// 铁律：1) 下单前必须重新算一次价，不能拿前端传来的金额；2) 每笔订单都要能单独取消。
export async function createOrder(client, { storeCode, beType = 1, orderType = 1, takeWayCode, items, remark }) {
  const base = { storeCode: String(storeCode), orderType, beType };

  // 下单前复核价格，顺带确认取餐方式可用
  const quoted = await client.call('calculate-price', { ...base, items });
  const q = quoted?.data || {};
  if (!Number.isFinite(Number(q.price)) || Number(q.price) <= 0) {
    throw new Error('这条组合当前算不出有效价格，可能优惠已失效');
  }
  const ways = (q.takeWayList || []).map((w) => w.code);
  const way = ways.includes(takeWayCode) ? takeWayCode : ways[0];

  const res = await client.call('create-order', {
    ...base,
    takeWayCode: way,
    items,
    ...(remark ? { remark: String(remark).slice(0, 50) } : {}),
  });
  const d = res?.data || res || {};
  const detail = d.orderDetail || {};
  if (!d.orderId) throw new Error('下单未返回 orderId：' + JSON.stringify(res).slice(0, 200));

  return {
    orderId: d.orderId,
    payId: d.payId || null,
    payH5Url: d.payH5Url || null,
    status: detail.orderStatus || '待支付',
    // create-order 的金额字段是「元」字符串（实测 "5"），与 calculate-price 的「分」不同
    totalAmount: Number(detail.totalAmount ?? 0),
    realAmount: Number(detail.realTotalAmount ?? 0),
    storeName: detail.storeName || null,
    takeWay: typeof detail.takeWay === 'string' ? detail.takeWay : detail.takeWay?.title || way,
    quotedPrice: Number(q.price) / 100,
    items: (detail.orderProductList || []).map((p) => ({
      name: p.productName,
      quantity: p.quantity,
      amount: Number(p.subtotal ?? p.amount ?? 0),
    })),
  };
}

export async function cancelOrder(client, orderId, reason = -1) {
  const res = await client.call('cancel-order', { orderId: String(orderId), cancelReasonCode: reason });
  const d = res?.data || res || {};
  return { ok: !!d.cancelResult, orderId: d.orderId || orderId };
}

export async function queryOrder(client, orderId) {
  const res = await client.call('query-order', { orderId: String(orderId) });
  return res?.data || res;
}
