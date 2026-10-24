// 解析麦当劳 list-nutrition-foods 返回的 TOON 格式
// 形如：[160]{productName,nutritionDescription,energyKj,...}:
//         猪柳麦满分,null,1288,308,16,16,24,781,213
export function parseToon(text) {
  if (!text || typeof text !== 'string') return [];
  const lines = text.split(/\r?\n/);
  let fields = null;
  const rows = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const head = line.match(/^\[\d+\]\{([^}]+)\}:?$/);
    if (head) { fields = head[1].split(',').map((s) => s.trim()); continue; }
    if (!fields) continue;
    const cells = line.split(',').map((s) => s.trim());
    if (cells.length < fields.length) continue;
    const row = {};
    fields.forEach((f, i) => {
      const v = cells[i];
      row[f] = v === 'null' || v === '' ? null : v;
    });
    rows.push(row);
  }
  return rows;
}

/** 营养表按餐品名做宽松匹配（菜单名往往带规格前后缀） */
export function matchNutrition(rows, name) {
  if (!name || !rows.length) return null;
  const norm = (s) => String(s || '').replace(/[（(].*?[)）]/g, '').replace(/\s/g, '');
  const target = norm(name);
  let hit = rows.find((r) => norm(r.productName) === target);
  if (!hit) hit = rows.find((r) => target.includes(norm(r.productName)) && norm(r.productName).length >= 3);
  if (!hit) hit = rows.find((r) => norm(r.productName).includes(target) && target.length >= 3);
  if (!hit) return null;
  return {
    kcal: hit.energyKcal ? Number(hit.energyKcal) : null,
    protein: hit.protein ? Number(hit.protein) : null,
    fat: hit.fat ? Number(hit.fat) : null,
    carb: hit.carbohydrate ? Number(hit.carbohydrate) : null,
    sodium: hit.sodium ? Number(hit.sodium) : null,
  };
}
