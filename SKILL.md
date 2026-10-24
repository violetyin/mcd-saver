---
name: mcd-saver
description: 麦门省钱助手。当用户问「麦当劳怎么点最划算 / 两个人一百块吃麦当劳点什么 / 帮我凑一单麦当劳 / 有什么券能用 / 这一单多少钱」时使用。输入人数、预算、忌口和门店，调用麦当劳 MCP 真实取门店、菜单、本店优惠券，逐个计算组合的实付价，输出 3 套方案；仅对同餐品同份数比较省钱，可附营养信息。涉及 query-nearby-stores、query-meals、query-store-coupons、calculate-price、query-meal-detail、list-nutrition-foods。
agent_created: true
---

# 麦门省钱助手

## 这个 Skill 解决什么

麦当劳的实际应付金额由「门店 + 当时菜单 + 账户里的券」三者共同决定，**标价相加永远不等于实付价**。所以这个 Skill 不做价格估算，而是把候选组合真的丢进 `calculate-price` 算一遍，再排序。

## 前置条件

1. 有麦当劳 MCP Token（在 https://open.mcd.cn/mcp 用手机号登录 → 控制台 → 激活 → 复制）。
2. 项目根目录存在 `.env`，内容至少一行：
   ```
   MCD_MCP_TOKEN=你的Token
   ```
   可选：`MCD_CITY=北京`、`MCD_KEYWORD=国贸` 作为默认门店搜索条件。
3. Node.js ≥ 18，无需 `npm install`（零依赖）。

## 首选用法：直接跑引擎

当用户给出「人数 + 预算 + 口味/忌口」时，执行：

```bash
node src/cli.mjs --people 2 --budget 100 --avoid 辣 --city 北京 --keyword 国贸 --nutrition
```

参数：

| 参数 | 含义 |
|---|---|
| `--people` / `-p` | 用餐人数 |
| `--budget` / `-b` | 预算（元）；加 `--per-person` 表示按人均预算 |
| `--avoid` | 忌口，逗号分隔：辣 / 牛肉 / 鸡肉 / 猪肉 / 鱼 / 咖啡 / 冰 |
| `--city` `--keyword` | 门店搜索范围和商圈关键词 |
| `--store` | 直接指定 storeCode，跳过门店搜索（用户已知门店时更快） |
| `--nutrition` | 附带热量/蛋白质/脂肪 |
| `--json` | 输出结构化 JSON（要二次加工或做网页时用） |

把命令输出的原文整理给用户即可，**不要自己重算金额**，也不要补充脚本没给出的价格。

## 备选用法：没有 .env 但有 mcd-mcp 连接器

按下面的顺序调用连接器工具，规则一样不能破：

1. `query-nearby-stores`：`beType=1`（到店自取），`searchType=2`，`city` + `keyword`（`searchType=1` 是搜「收藏餐厅」，新账号大概率返回空）。
2. `query-meals`：`{ storeCode, orderType:1, beType:1 }`。
3. `query-store-coupons`：同上参数。**券按门店和场景区分，换门店要重查。**
4. 组 3～6 个候选方案，对每个候选调 `calculate-price`。
5. 汇报时附上本次调用过的工具和次数。

## 五条铁律（违反就会给出错价）

1. **金额只认 `calculate-price`**，返回单位是**分**，展示时除以 100。`query-meals` 里的 `currentPrice` 只是划线价，不能用来比价。
2. **`beType=1` 不传 `beCode`**。到店自取传了会报错；只有得来速(5)、外送(2)、团餐(6) 才必须传。
3. **用券必须显式带 `couponId` + `couponCode`**。只买券商品而不带券 ID 时，`calculate-price` 会返回 `price=0`——**必须当作无效结果剔除**，否则它会被排成「最便宜」。
4. **券只能用于它绑定的 `products[].productCode`**，不能张冠李戴。
5. **`list-nutrition-foods` 返回的是 TOON 不是 JSON**（`[160]{productName,...}:` + 逗号分隔行），要用解析器处理，不能让模型目测累加。

## 输出怎么解读

- **实付**：`calculate-price` 的 `price`，含券。
- **标价**：同一次返回的 `originalPrice`，是这些东西的原价合计。
- **比单点省**：仅当推荐方案与单点参考餐的商品及份数完全相同时显示。
- **人均**：订单总实付除以用户输入的实际用餐人数。

## 边界（明确不做）

- **下单必须二次确认，且默认不付钱**。`create-order` 会创建真实订单（状态「待支付」）并返回 `payH5Url`，是否付款由用户决定；下单前一定要复述门店、取餐方式、明细和实付金额，得到明确同意再调。
- **每一笔订单都要给出取消路径**。`cancel-order` 的 `cancelReasonCode`：1 改主意 / 2 重复下单 / 3 点错 / 4 信息填错 / 5 时间选错 / -1 其它。
- **拆单方案要提前警告**：几张券拆几单就是几笔真实订单，付款要付几次，取消也要取消几次。
- **不承诺绝对最低价**。枚举的是有限候选组合（默认 16 个以内），结论表述为「在试过的组合里最划算」。
- **忌口只按餐品名匹配**，套餐内部构成受门店当日在售影响，辣度类判断要提示用户复核。
- 餐品、价格、券以该门店当时的实时返回为准，跨天失效。
