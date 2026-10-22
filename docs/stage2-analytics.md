# 阶段 2 · 数据分析 Agent（后端能力）

> 交付范围：`/api/chat` 显式 task 分流 + 自然语言转工单查询 + 8 个只读指标 + CSV 导出 + 分析接口权限与限流
> 前端业务文件（`assets/app.js`、`assets/admin.js`、`assets/kb.js`）**零改动**

---

## 一、整体链路

```
自然语言问句
   │
   ├─(规则解析 parse.js)──► 结构化 DSL ──┐
   │   命中关键词字典 + 时间/过滤/条数     │
   │                                      ├─► 白名单校验(dsl.js) ─► 只读执行器(execute.js) ─► 行集 + 摘要
   └─(模型兜底 reply.js task=analytics_parse)┘         │
                                         没通过就直接拒绝，不执行
```

三条硬约束落地方式：

| 约束 | 落地 |
| --- | --- |
| 只读，不改业务数据 | 执行器是纯函数 `run(dsl, db, today)`，测试断言"执行前后 JSON 快照完全一致" |
| 不拼 SQL、不执行任意查询 | DSL 是指标枚举 + 维度枚举 + 过滤枚举，`normalize()` 不认的键/值一律拒绝；没有字符串拼接 |
| 权限 + 频率限制 | 管理员口令校验（坐席口令拒绝），每操作者 30 次/分钟（`CS_ANALYTICS_RATE` 可调），单次返回 ≤200 行、时间窗 ≤90 天 |

---

## 二、`/api/chat` 的 task 分流（阶段2 第一项）

请求体新增可选字段：

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| `task` | `answer` / `classify` / `summary` / `analytics` | 不传则按旧的 system 提示词特征推断 |
| `authCode` | 管理员口令 | **仅** `task=analytics` 需要 |

兼容性设计：

- `reply.respond(messages)`（旧签名）与 `reply.respond({task, messages})`（新签名）**产出完全一致**，有专门测试逐字比对。
- 未知 `task` 值：HTTP 400 明确拒绝（不静默当成 answer）。
- 未知 task → 自动识别；非法 task → 400。
- GitHub Pages 静态版不发 `task`，走自动识别，行为不变。

```bash
# 旧调用（前端现在就是这条路径）
curl -s -X POST http://localhost:8080/api/chat -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"system","content":"本轮系统判定的用户意图：查询订单（order）。\n系统实时查询到的订单信息（可直接引用，不要改写数字）：\n- 订单号：A2024001\n- 商品：净化器\n- 状态：已签收\n- 快递：顺丰 SF1234567890123\n"},{"role":"user","content":"A2024001 到哪了"}]}'

# 新调用：显式任务
curl -s -X POST http://localhost:8080/api/chat -H 'Content-Type: application/json' \
  -d '{"task":"classify","messages":[{"role":"user","content":"用户消息：App 一打开就闪退"}]}'
```

---

## 三、分析接口（RPC）

### 3.1 自然语言查询

`cs_admin_analytics`（管理员口令）

| 入参 | 必填 | 说明 |
| --- | --- | --- |
| `p_code` | 是 | 管理员口令 |
| `p_query` | 二选一 | 自然语言问句，≤200 字 |
| `p_dsl` | 二选一 | 结构化查询，优先级高于 `p_query` |

返回：

```json
{
  "ok": true,
  "metric": "ticket_trend",
  "metric_label": "工单量趋势",
  "range": { "from": "2026-10-16", "to": "2026-10-22", "days": 7 },
  "columns": [{ "key": "day", "label": "日期" }],
  "rows": [{ "day": "2026-10-22", "conversations": 3, "handoff": 1, "closed": 2, "rated": 1, "avg_score": 5 }],
  "total": 12,
  "summary": "2026-10-16 至 2026-10-22 共新建工单 12 条…",
  "read_only": true,
  "query": {
    "text": "近 7 天工单量趋势",
    "source": "rules",
    "confidence": 0.86,
    "signals": { "metric": "ticket_trend", "keyword": "趋势", "time": "近 7 天", "filters": {} },
    "dsl": { "metric": "ticket_trend", "dimension": "day", "days": 7, "limit": 20, "order": "desc", "filters": {} },
    "elapsed_ms": 3
  }
}
```

> `query.signals` 就是"我是怎么理解这句话的"，出问题时看这里最快。

### 3.2 支持的指标（8 个）

| metric | 中文 | 默认窗口 | 行结构 |
| --- | --- | --- | --- |
| `ticket_trend` | 工单量趋势 | 14 天 | `day, conversations, handoff, closed, rated, avg_score` |
| `intent_share` | 意图标签占比 | 30 天 | `intent, label, count, pct` |
| `agent_workload` | 坐席工作量 | 30 天 | `agent, claimed, resolved, resolve_rate, avg_first_response, rated, avg_score, good_rate` |
| `rating_dist` | 评价分布 | 30 天 | `score, count, pct`（另给 `extra.avg_score / rated_count / satisfied_rate`） |
| `faq_hit_rate` | FAQ 命中率 | 14 天 | `day, hits, misses, total, hit_rate` |
| `unresolved` | 未解决工单 | 当前态 | `id, status_label, intent_label, user_label, assignee_name, wait_seconds, last_message` |
| `knowledge_gaps` | 高频知识缺口 | 30 天 | `question, cnt, intent_label, last_seen` |
| `overview` | 运营总览 | 14 天 | 单行：`period, conversations, open, waiting, avg_score, faq_hit_rate, top_intent` |

口径说明（写死在文档里，避免"同一个词两种算法"）：

- **工单量** = 区间内 `created_at` 落在窗口的会话数；转人工按 `handoff_at`、已解决按 `updated_at` 且状态 `closed`。
- **坐席工作量**：`claimed` = 期间创建且 `assignee_name` 命中；`avg_first_response` = `claimed_at` → 该会话第一条 `agent` 消息的秒数；`good_rate` = 4 星及以上 / 有评价数。
- **FAQ 命中率**：只统计 `meta.faq_miss` 有值的用户消息（老数据没有这个标记就不参与，避免把"未知"算成命中）。
- **未解决工单**：`status ∈ {active, handoff}`，反映当前状态，**不受时间窗限制**（返回里带 `note` 说明）。
- **知识缺口** = `meta.faq_miss === true` 的用户提问，按原文聚合计数。

### 3.3 指标清单

`cs_admin_analytics_meta`：返回 8 个指标的 label/desc/默认窗口/维度、过滤枚举、限流阈值，供后续看板做下拉与文档自动生成。

### 3.4 时间与过滤的写法

| 问法示例 | 解析结果 |
| --- | --- |
| 近 14 天 / 最近一周 / 昨天 / 本月 / 上个月 / 近三个月 | `days` 或 `from+to` |
| 10月1日到10月22日 / 2026-10-01 至 2026-10-22 | 显式区间 |
| 待接入 / 已解决 / 进行中 | `filters.status` |
| 退款 / 订单 / 技术 | `filters.intent` |
| 客服A / 管理员 | `filters.agent` |
| top5 / 前 10 条 | `limit` |

---

## 四、CSV 导出（沿用原入口）

`cs_admin_export` 增加 `p_dataset`，**不传时行为与改造前完全一致**：

| 调用 | 结果 |
| --- | --- |
| `{p_code}` 或 `{p_code, p_status}` | 逐条消息导出（原有能力，不动） |
| `{p_code, p_dataset:'analytics', p_query:'各意图标签占比'}` | 返回 `csv`（带 BOM，Excel 直开）、`filename`、`row_count`、`summary` |
| `{p_code, p_dataset:'analytics', p_dsl:{...}}` | 同上，跳过自然语言解析 |

---

## 五、自测（53 条，全部通过）

```bash
npm test          # 等价于 node --test test/analytics.test.js test/chat-task.test.js test/http.test.js
```

| 文件 | 数量 | 覆盖 |
| --- | --- | --- |
| `test/analytics.test.js` | 31 | DSL 白名单拒绝、13 条自然语言解析、8 个指标口径逐项断言、只读性（快照比对）、时间窗外不计入、限流窗口、CSV 结构、meta |
| `test/chat-task.test.js` | 7 | 新旧签名等价（answer/classify/summary 三路逐字比对）、未知 task、analytics_parse 不猜指标、不编造物流信息 |
| `test/http.test.js` | 15 | 真起进程打通：原链路（建会话→订单→对话）、task 分流、非法 task 400、分析无口令 403、坐席口令被拒、NL 查询、DSL 直传、听不懂给建议、非法 DSL 拒绝、meta、两种导出、限流触发 |

关键回归点：**原有链路一条没动**（`/api/chat` 不带 task、`cs_admin_export` 不带 dataset、`cs_admin_stats` 字段未增删）。

---

## 六、本期没做（按计划留给后续阶段）

| 项 | 归属 |
| --- | --- |
| 分析结果的可视化页面（饼图/趋势图/绩效面板） | 阶段5 |
| 结构化日志、`/health`、traceId | 阶段4 |
| 多环境配置（dev/test/prod）、CORS、日志级别 | 阶段3 |
| 真实模型接入 `analytics_parse` | 拿到凭据后，只改 `reply.js` 一个函数体 |

---

## 七、风险与取舍

1. **规则解析的边界**：问句里同时出现两个指标（如"退款工单趋势和满意度"）时只取主指标，不做多指标拼接。这是刻意的——多指标会引出"结果怎么合并"的口径问题，留给阶段5 的看板用固定组合解决。
2. **限流键是"管理员口令"而非 IP**：多管理员共用一个键。阶段3 引入环境配置时一并改成 `IP + 口令`，并能按环境设不同阈值。
3. **`agent_workload` 的首响依赖 `claimed_at`**：历史数据若没有认领时间，该坐席的 `avg_first_response` 会是 `null`，不参与平均，不会拉低结果。
4. **导出走同一限流器**：大屏连续导出会被限流挡住，这是有意的自我保护；确需批量导出应走离线任务（阶段6 之后再说）。
