import test from 'node:test';
import assert from 'node:assert/strict';
import { perPerson, sameBasket, nutritionForComponents } from '../src/recommendation.mjs';
import { runSaver } from '../src/saver.mjs';

/** 造一个假客户端：只实现本项目用到的工具，价格由 menu 决定 */
function fakeClient(menu, { coupons = [], detail = {}, couponPrice = null, nutritionRows = null } = {}) {
  const priceOf = (code) => Number(menu.meals[code]?.currentPrice || 0);
  return {
    calls: 0,
    async init() {},
    async call(tool, args) {
      this.calls++;
      if (tool === 'query-meals') return { data: menu };
      if (tool === 'query-store-coupons') return { data: coupons };
      if (tool === 'query-my-coupons') return null;
      if (tool === 'available-coupons') return null;
      if (tool === 'query-my-account') return null;
      if (tool === 'order-list') return null;
      if (tool === 'list-nutrition-foods') return nutritionRows ? { data: nutritionRows } : null;
      if (tool === 'query-meal-detail') return { data: detail[args.code] || null };
      if (tool === 'calculate-price') {
        const items = args.items || [];
        let price = 0;
        const productList = [];
        for (const it of items) {
          const base = priceOf(it.productCode) * it.quantity;
          // 带券的商品按券价算，模拟真实接口的折扣
          const unit = it.couponId && couponPrice != null ? couponPrice : priceOf(it.productCode);
          const subtotal = unit * it.quantity;
          price += subtotal;
          productList.push({
            productName: menu.meals[it.productCode]?.name || it.productCode,
            quantity: it.quantity,
            subtotal,
            originalSubtotal: base,
          });
        }
        return { data: { price, originalPrice: productList.reduce((s, p) => s + p.originalSubtotal, 0), discount: 0, productList } };
      }
      return null;
    },
  };
}

const baseMenu = {
  categories: [
    { name: '汉堡', meals: [{ code: 'burger' }] },
    { name: '小食', meals: [{ code: 'side' }] },
    { name: '饮品', meals: [{ code: 'drink' }] },
  ],
  meals: {
    burger: { name: '巨无霸', currentPrice: 5000 },
    side: { name: '小薯条', currentPrice: 3000 },
    drink: { name: '纯悦', currentPrice: 3000 },
  },
};

test('price comparison requires identical products and quantities', () => {
  const baseline = [{ code: 'burger', quantity: 2 }, { code: 'drink', quantity: 2 }];
  assert.equal(sameBasket([{ code: 'drink', quantity: 2 }, { code: 'burger', quantity: 2 }], baseline), true);
  assert.equal(sameBasket([{ code: 'burger', quantity: 2 }], baseline), false);
  assert.equal(sameBasket([{ code: 'burger', quantity: 2, couponId: 'one' }, { code: 'drink', quantity: 2 }], baseline), false);
});

test('nutrition multiplies portions and reports which components are missing', () => {
  const rows = [
    { productName: '巨无霸', energyKcal: '513', protein: '27', fat: '26' },
    { productName: '纯悦', energyKcal: '0', protein: '0', fat: '0' },
  ];
  assert.deepEqual(
    nutritionForComponents(rows, [{ name: '巨无霸', quantity: 2 }, { name: '纯悦', quantity: 2 }]),
    { kcal: 1026, fat: 52, protein: 54, matched: 2, total: 2, missing: [], complete: true },
  );
  // 营养表没有的餐品：能算的照算，缺的列出来，不整条丢掉
  const partial = nutritionForComponents(rows, [{ name: '巨无霸', quantity: 1 }, { name: '可乐麦炫酷', quantity: 1 }]);
  assert.equal(partial.kcal, 513);
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.missing, ['可乐麦炫酷']);
  // 一项都匹配不上才返回 null
  assert.equal(nutritionForComponents(rows, [{ name: '未知小食', quantity: 1 }]), null);
});

test('一人一单等多份时，人均按实际用餐人数算', async () => {
  const menu = {
    categories: [{ name: '多人餐', meals: [{ code: 'share' }] }, ...baseMenu.categories.filter((c) => c.name !== '多人餐')],
    meals: { ...baseMenu.meals, share: { name: '双人分享餐', currentPrice: 8000 } },
  };
  const client = fakeClient(menu, {
    detail: { share: { name: '双人分享餐', rounds: [{ choices: [
      { name: '巨无霸', quantity: 1, isDefault: 1 },
      { name: '纯悦', quantity: 1, isDefault: 1 },
    ] }] } },
  });
  const r = await runSaver({ client, people: 3, budget: 200, storeCode: '123' });
  const share = r.plans.find((p) => p.kind === 'multi');
  assert.ok(share, '应该有多人餐方案');
  assert.equal(share.perPerson, perPerson(share.price, 3));
});

test('券 ≥2 张且人数 ≥2 时触发拆单，逐单算价后汇总', async () => {
  const menu = {
    categories: baseMenu.categories,
    meals: { ...baseMenu.meals, c1: { name: '券套餐A', currentPrice: 4000 }, c2: { name: '券套餐B', currentPrice: 4000 } },
  };
  const coupons = [
    { title: '券A', couponId: 'A', couponCode: 'CA', products: [{ productCode: 'c1', productName: '券套餐A' }] },
    { title: '券B', couponId: 'B', couponCode: 'CB', products: [{ productCode: 'c2', productName: '券套餐B' }] },
  ];
  const client = fakeClient(menu, { coupons, couponPrice: 800 });
  const r = await runSaver({ client, people: 2, storeCode: '123' });
  const split = r.plans.find((p) => p.kind === 'split') || r.alternatives.find((p) => p.kind === 'split');
  assert.ok(split, '两张券时应该出现拆单方案');
  assert.equal(split.ordersDetail.length, 2, '两张券应该拆成两单');
  assert.equal(split.price, 1600, '两单券价相加 800×2');
  assert.equal(split.covers, 2);
});

test('套餐比同样单品分开买便宜时，给出同餐品单点价', async () => {
  const menu = {
    categories: [{ name: '单人餐', meals: [{ code: 'combo' }] }, ...baseMenu.categories],
    meals: { ...baseMenu.meals, combo: { name: '超值单人餐', currentPrice: 1300 } },
  };
  const client = fakeClient(menu, {
    detail: { combo: { name: '超值单人餐', rounds: [{ choices: [
      { name: '巨无霸', quantity: 1, isDefault: 1 },
      { name: '纯悦', quantity: 1, isDefault: 1 },
    ] }] } },
  });
  const r = await runSaver({ client, people: 1, budget: 100, storeCode: '123' });
  const plan = r.plans.find((p) => p.code !== undefined) || r.plans[0];
  const withSame = r.plans.find((p) => p.sameItems);
  assert.ok(withSame, '套餐方案应该有同餐品单点价');
  // 单品 5000+3000=8000 分，套餐 1300 分
  assert.equal(withSame.sameItems.price, 8000);
  assert.equal(withSame.sameItems.saved, 6700);
  assert.ok(plan);
});
