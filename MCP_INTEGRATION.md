# 麦当劳 MCP 集成说明

## 1. 使用的 MCP Server

| 项 | 内容 |
|---|---|
| 服务名 | `mcd-mcp`（官方远程托管，`serverInfo.version` = 1.0.0） |
| 接入地址 | `https://mcp.mcd.cn` |
| 传输协议 | Streamable HTTP |
| 鉴权 | 请求头 `Authorization: Bearer <MCP_TOKEN>` |
| 客户端实现 | `src/mcp.mjs`，零依赖手写 JSON-RPC，不引入 SDK，评委 `git clone` 后无需 `npm install` |

Token 只从 `.env` 的 `MCD_MCP_TOKEN` 读取，仓库内 `.env` 已被 `.gitignore` 排除，`MCP_INTEGRATION.md` 与代码中只出现占位符。

## 2. 实际调用的 Tool

| Tool | 在本项目里干什么 | 调用次数（一次典型运行） |
|---|---|---|
| `query-nearby-stores` | 按「城市 + 商圈关键词」定门店，拿 `storeCode` | 1 |
| `query-meals` | 拉当店在售菜单（本次 102 个餐品 / 15 个类目） | 1 |
| `query-store-coupons` | 查该门店 + 到店自取场景下的可用券（`couponId` / `couponCode` / 绑定商品） | 1 |
| `calculate-price` | **核心**：每个候选组合算一次实付价（含券），另算 1 次单点基线 | 17 |
| `query-meal-detail` | 给前三个方案补「套餐默认含哪些餐品」 | ≤3 |
| `list-nutrition-foods` | `--nutrition` 时取营养表（TOON 格式） | 1 |
| `order-list` | 取最近 10 笔历史订单，算个人单均与最近一单 | 1 |
| `query-my-coupons` | 账户已持券（返回 markdown，非 JSON） | 1 |
| `available-coupons` | 麦麦省可领未领券（markdown） | 1 |
| `query-my-account` | 积分：可用 / 已过期 / 本月将过期 | 1 |
| `auto-bind-coupons` | 一键领券（账户写操作，需二次确认） | 0 或 1 |
| `create-order` | 用户确认后创建订单，返回 `payH5Url`（未支付） | 按方案笔数 |
| `cancel-order` | 取消刚创建的订单，`cancelReasonCode=-1` | 按需 |
| `now-time-info` | 未使用 | 0 |

合计约 **20～24 次/次运行**，远低于官方 600 次/分钟的限流。

## 3. 调用流程

```
用户输入（人数 / 预算 / 忌口 / 商圈）
        │
        ▼
query-nearby-stores (beType=1, searchType=2, city+keyword)
        │  storeCode（到店自取不传 beCode）
        ▼
query-meals ──────► 按类目分桶：多人餐 / 单人套餐 / 主食 / 小食 / 饮品
query-store-coupons ─► 本店可用券（绑定 productCode）
        │
        ▼
生成候选组合（≤18 个模板）
   ① 券方案：券商品 ×1（人数>1 时补最便宜主食）
   ② 单人套餐 × 人数
   ③ 多人餐 × ceil(人数/2)
   ④ 自由搭配：主食×N + 小食×N + 饮品×N
        │
        ▼
calculate-price ×N ──► 每个候选的 price / originalPrice / discount（单位：分）
        │                 剔除 price<=0 的异常返回
        ▼
单点参考餐 calculate-price(主食×N + 小食×N + 饮品×N)
        │
        ▼
估算覆盖人数过滤 → 预算过滤 → 按实际用餐人数算人均 → 取前 3
        │
        ▼
query-meal-detail（前 3 个）→ 套餐构成
list-nutrition-foods（可选）→ TOON 解析 → 热量/蛋白/脂肪
```

## 4. 业务价值

麦当劳的真实应付金额由 **门店 × 当时菜单 × 账户券** 三者共同决定，所以任何「把标价加起来」的估算都会失真。本项目把最耗心力的三步自动化：

1. **先定门店再谈价格**：券按门店生效，同一个账户在不同门店可用的券不同。跳过门店直接比价，是这个场景里最常见的错误。
2. **用真实算价替代心算**：候选组合逐个过 `calculate-price`，把券的减免、划线价、套餐价一次算清。
3. **给出可核实的节省金额**：同商品同份数时才与单点参考餐比较；券的优惠则用同一组合的原价与实付价比较。

历史实测：两人 100 元预算，某组合实付 27.8 元；另一个不同餐品的参考点法实付 53 元，两者不可直接表述为节省比例。同一张「麦辣鸡腿堡三件套」券的同组合原价与实付价相差 23.1 元。

## 5. 踩过的坑（都已写进代码）

| 坑 | 现象 | 处理 |
|---|---|---|
| 券商品不带券 ID | `calculate-price` 返回 `price=0`，排序会把它排成"最便宜" | 剔除 `price<=0` 的结果 |
| 到店自取传了 `beCode` | 接口报错 | `beType=1` 时明确不传 `beCode` |
| `searchType=1` | 搜「收藏餐厅」，新账号返回空列表 | 默认 `searchType=2`（城市+关键词），失败才回落 |
| 返回体不是纯 JSON | `text` 是「markdown 说明 + JSON 正文」的拼接 | 括号配对扫描定位 JSON 段 |
| 营养是 TOON 格式 | `[160]{productName,...}:` + 行数据，非 JSON | `src/toon.mjs` 单独解析，不交给模型目测 |
| 并发调用偶发失败 | `Promise.all` 三连发时券接口返回异常，被静默吞成"0 张券" | 改串行 + 错误显式回传 |
| 金额单位 | 返回的是**分** | 统一除以 100 再展示 |
| 套餐明细 | `rounds[].choices[]` 里 `isDefault=1` 才是默认内容 | 只取默认项，避免列出所有可选项 |
| **套餐构成被多算** | 同一轮里既有 `isDefault=1` 又有 `quantity>0` 的选项（实测粉区：怡泉+C麦炫酷标默认但 quantity=0，真正选中是 quantity=1 的阳光柠檬红茶），两个都算会让「同餐品单点价」虚高 | 每轮优先取 `quantity>0` 的选项，没有再退回 `isDefault`；按轮取，不跨轮合并 |
| **已领取的券仍出现在可领列表** | `available-coupons` 里领过的券状态变为「已领取」但仍列出，导致「还能领 N 张」永远不变、点领取报「暂无可领取」 | 只保留 `status === '可领取'`；注意「不可领取」也含「可领取」三字，必须整串相等 |
| **营养表覆盖不全** | `list-nutrition-foods` 只收录常见餐品，麦炫酷系列等饮品一条都没有，要求「全部命中才输出」会让套餐营养永远为空 | 改为能算的算出来，缺哪几项明确列出，由展示层标注覆盖率 |

## 6. 可扩展方向

- **外送场景**：`orderType=2` + `delivery-query-addresses` / `delivery-query-stores`，加配送费与门槛。
- **随单购**：`withOrder` 字段（麦金卡、早餐卡）目前只展示未纳入组合。
- **企业团餐满减**：`query-promotions`（仅 `beType=6`）可拿到满减/满折规则，值得做成"凑单到门槛"策略。
- **下单**：网页在用户确认后可调用 `create-order` 创建待支付订单，并提供逐笔取消入口。
