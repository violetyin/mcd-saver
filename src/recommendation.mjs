import { matchNutrition } from './toon.mjs';

export function perPerson(priceFen, people) {
  return Math.round(priceFen / people) / 100;
}

// A price comparison is meaningful only for the same products and quantities.
export function sameBasket(left, right) {
  if (!left?.length || !right?.length) return false;
  const tally = (items) => {
    const out = new Map();
    for (const item of items) {
      if (!item.code || item.couponId) return null;
      out.set(item.code, (out.get(item.code) || 0) + Number(item.quantity));
    }
    return out;
  };
  const a = tally(left);
  const b = tally(right);
  return !!a && !!b && a.size === b.size && [...a].every(([code, quantity]) => b.get(code) === quantity);
}

// 营养表只收录常见餐品（麦炫酷系列等饮品没有），所以不能要求全部命中。
// 改为：能算的算出来，缺哪几项明确列出来，由展示层标注覆盖率。
export function nutritionForComponents(rows, components) {
  if (!components?.length) return null;
  let kcal = 0, fat = 0, protein = 0, matched = 0;
  const missing = [];
  for (const { name, quantity } of components) {
    const n = matchNutrition(rows, name);
    const q = Number(quantity);
    if (!n || ![n.kcal, n.fat, n.protein].every(Number.isFinite)
      || !Number.isFinite(q) || q <= 0) {
      missing.push(name);
      continue;
    }
    kcal += n.kcal * q;
    fat += n.fat * q;
    protein += n.protein * q;
    matched++;
  }
  if (!matched) return null;
  return {
    kcal: Math.round(kcal),
    fat: Math.round(fat),
    protein: Math.round(protein),
    matched,
    total: components.length,
    missing: [...new Set(missing)],
    complete: missing.length === 0,
  };
}
