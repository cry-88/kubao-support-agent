# 阶段 1 · 仓库代码梳理评估报告

> 评估对象：`kubao-support-agent`（哭包智能客服）
> 评估时间：2026-10-22
> 评估方式：全量通读源码 + 接口/函数逐一对齐 + 真实浏览器链路复跑
> 结论先行：**具备改造条件，前端业务代码可以不动**。主要工作量在后端新增模块（数据分析、配置、日志）与部署工程，不需要推倒重来。

---

## 一、代码规模与模块职责

| 文件 | 行数 | 职责 | 改造评价 |
| --- | ---: | --- | --- |
| `server.js` | 244 | HTTP 入口：静态托管 + `/api/rpc`、`/api/faqs`、`/api/models`、`/api/chat`(SSE)；路径穿越防护；`/data` 对外 404 | 阶段2/4 的落点，天然适合加中间件（日志、限流、异常兜底） |
| `server/rpc.js` | 764 | 27 个 `cs_*` 业务函数，参数名 `p_xxx`、返回 `{ok:true,...}` 对齐 `schema.sql` | 保持不动，只做增量（新增分析类 RPC） |
| `server/store.js` | 150 | JSON 文件存储：7 张表、自增 id、原子落盘（tmp+rename）、首启种子数据 | 阶段8 迁移 PostgreSQL 的替换点；阶段2 需为分析查询加只读快照 |
| `server/reply.js` | 197 | 本地应答引擎：解析 system 提示词里的 FAQ 块/订单块后模板化作答；兼做意图分类 JSON 与会话摘要 | 阶段2"复用模型入口"的枢纽，需先把 task 分流显式化 |
| `assets/config.js` | 174 | 客户端通道 shim：`database.rpc` / `from().select().order()` / `llm.models.list` / `llm.chat.completions.create`(流式) + `unwrapRpc` + `getGuestKey` | 阶段3/7 的环境开关就加在这里，前端其它文件可不动 |
| `assets/app.js` | 1076 | 用户端：多轮对话、意图、FAQ 检索、订单查询、转人工、轮询、摘要、评分 | **不改**（约束2） |
| `assets/admin.js` | 800 | 坐席/管理端：工单队列、认领、统计渲染、知识库、知识缺口、CSV 导出 | **尽量不改**；阶段5 看板新增图表建议用追加 DOM + 新接口 |
| `assets/kb.js` | 154 | 意图规则、FAQ 检索打分、提示词构造 | **不改**（提示词格式是后端解析的契约，见风险 R7） |
| `index.html` / `admin.html` / `404.html` | 77 / 245 / 71 | 三个页面骨架 | 阶段5 需在 `admin.html` 追加图表容器；阶段7 加模式提示 |
| `schema.sql` | 762 | PostgreSQL 建表 + RLS + 28 个函数 + 种子数据 | 阶段8 迁移的唯一事实来源，保持与 `rpc.js` 对齐 |
| `assets/styles.css` / `admin.css` | 531 / 181 | 样式 | 阶段5 视图表方案追加 |
| `.github/workflows/deploy-pages.yml` | — | Pages 发布 + 语法检查 + 密钥扫描 | 阶段7 复用；需改为只部署静态前端 |
| `data/store.json` | 运行时 | 全部业务数据（含口令） | **未进 .gitignore，风险 R1** |

依赖：**零 npm 依赖**，Node ≥ 18（`fetch`、`TextDecoder`、`webcrypto`）。前端无框架、无打包。这是很大的优势——部署时不需要 `npm install`，也不存在构建产物与源码不一致的问题。

---

## 二、接口清单

### 2.1 通道形态

前端不直连数据表，统一走 `POST /api/rpc`（body: `{name, params}`，回包 `{data}` 或 `{error}`），与 PostgreSQL 版 `SECURITY DEFINER` 函数一一对应。`unwrapRpc` 的契约是硬约束：**只认 `{data}` / `{error}`，且业务失败靠 `data.ok === false` + `data.error` 字符串**（部分错误码映射成中文，见 `config.js` 的 MESSAGES 表）。

### 2.2 访客侧（校验 `guest_key`，无登录）

| 函数 | 入参 | 出参 | 备注 |
| --- | --- | --- | --- |
| `cs_guest_start` | `p_guest_key` `p_user_label?` | `{conversation_id}` | 建会话并写欢迎语；key 长度 < 12 拒绝 |
| `cs_guest_list` | `p_guest_key` | `{items[]}` 含 `last_message` | 取 30 条，按 `updated_at` 倒序 |
| `cs_guest_messages` | `p_guest_key` `p_conversation_id` | `{items[]}` | **前端未使用**（改用 `poll` 全量拉取） |
| `cs_guest_append` | `guest_key` `conversation_id` `role` `content` `intent?` `meta?` | `{id}` | **限流：同访客 user 消息 12 条/分钟**；内容截断 8000 字 |
| `cs_guest_update` | `…` `p_status?` `p_intent?` `p_intent_score?` | `{ok}` | `handoff_at` 只写一次 |
| `cs_guest_rate` | `…` `p_score` `p_feedback?` | `{ok}` | 1–5 校验 |
| `cs_guest_poll` | `…` `p_after_id` | `{status,assignee_name,summary,summary_upto_id,items[]}` | 4 秒轮询，增量取 `id > after` |
| `cs_guest_contact` | `…` `p_contact` | `{ok}` | 非工作时间留言，截断 120 字 |
| `cs_guest_summary_save` | `…` `p_summary` `p_upto_id` | `{ok}` | 摘要截断 1500 字，`upto` 取 max 不回退 |

### 2.3 工具

| 函数 | 入参 | 出参 | 备注 |
| --- | --- | --- | --- |
| `cs_lookup_order` | `p_order_no` | 订单对象或 `null` | **完全公开、无鉴权**（风险 R3） |

### 2.4 坐席侧（校验坐席口令）

| 函数 | 入参 | 出参 |
| --- | --- | --- |
| `cs_console_login` | `p_code` | `{agent_id,name,is_admin}`；失败回 `unauthorized` / `too_many_attempts` |
| `cs_agent_queue` | `p_code` | `{me,waiting[],mine[],others[],resolved_today}`；每行含 `wait_seconds` |
| `cs_agent_claim` | `p_code` `p_conversation_id` | `{assignee}`；已被人认领回 `claimed_by_other`；非队列态回 `not_in_queue` |
| `cs_agent_release` | `p_code` `p_conversation_id` | `{ok}`；仅限"handoff + 自己是 assignee" |
| `cs_agent_messages` | `p_code` `p_conversation_id` | `{me,conversation,items[]}` |
| `cs_agent_reply` | `p_code` `p_conversation_id` `p_content` | `{id,agent_name}`；未认领会自动认领 |
| `cs_agent_resolve` | `p_code` `p_conversation_id` | `{ok}`；置 `closed` + 写系统消息 |

### 2.5 管理侧（校验管理员口令，坐席口令一律拒绝）

`cs_admin_stats`、`cs_admin_conversations`（分页 `p_limit/p_offset/p_status`）、`cs_admin_messages`、`cs_admin_reply`、`cs_admin_resolve`（`p_resolved`）、`cs_admin_faq_list`、`cs_admin_faq_save`（`p_id` 为空即新增）、`cs_admin_faq_delete`、`cs_admin_gaps`（`p_days`，默认 30）、`cs_admin_export`（`p_status`，上限 5000 行，逐消息展开）。

### 2.6 HTTP 端点

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `/api/rpc` | POST | 统一 RPC 入口，body 上限 2MB |
| `/api/faqs` | GET | 公开只读，仅 `enabled` 且按 `priority` 倒序 |
| `/api/models` | GET | 当前返回单一"本地应答引擎" |
| `/api/chat` | POST | SSE 流式：`data: {choices:[{delta:{content}}]}` … `data: [DONE]` |
| `/`、`/*.html`、`/assets/*` | GET | 静态托管，HTML 强制 `no-store` |
| `/health` | — | **尚不存在**（阶段4 交付） |

---

## 三、数据模型（7 张表）

| 表 | 关键字段 | 用途 | 访问方式 |
| --- | --- | --- | --- |
| `cs_conversations` | `status`(active/handoff/closed)、`intent`、`intent_score`、`satisfaction`、`feedback`、`contact`、`message_count`、`handoff_at`、`assignee_id/name`、`claimed_at`、`summary`、`summary_upto_id`、`created_at`、`updated_at` | 会话主表，承载状态机与评价 | 仅函数 |
| `cs_messages` | `conversation_id`、`role`(user/assistant/agent/system)、`content`、`intent`、`meta`(jsonb)、`created_at` | 消息流水；`meta.faq_miss` 是知识缺口统计的唯一来源 | 仅函数 |
| `cs_faqs` | `question`、`answer`、`category`、`keywords`、`priority`、`enabled` | 知识库 | 公开只读（仅 enabled）+ 管理员写 |
| `cs_orders` | `order_no`、`item`、`amount`、`status`、`carrier`、`tracking_no`、`eta` | 演示订单 | 仅 `cs_lookup_order` |
| `cs_agents` | `name`、`code`、`is_active`、`last_seen_at` | 坐席账号 | 仅函数 |
| `cs_settings` | `key`、`value` | `admin_code` 明文 | 仅函数 |
| `cs_login_attempts` | `code_hash`(md5)、`ok`、`created_at` | 防爆破审计，仅存 md5 | 仅函数 |

**种子数据**：12 条 FAQ（退款 4 / 订单 4 / 技术 3 / 通用 1）、3 个演示订单（`A2024001` 已签收、`B2024002` 运输中、`C2024003` 待发货）、1 个管理员口令、2 个坐席（客服A/B）。当前实现里口令为 `kubao-admin-2026` / `kubao-agent-1` / `kubao-agent-2`。

会话状态机：`active`（智能应答）→ `handoff`（待人工 / 人工处理中）→ `closed`（结束并评价）。`assignee_id` 为空 = 在队列里等，非空 = 已锁定。

---

## 四、现有机制实现方式

### 4.1 鉴权（三层）

1. **访客**：`localStorage` 里 48 位 hex `guest_key`，服务端每次校验 `conversation.guest_key === p_guest_key`。无登录、无 token、无 IP 绑定——"持有即身份"。
2. **坐席**：`cs_operator(code)` 先比 `cs_settings.admin_code`（命中即 `operator_id=0` 管理员），再查 `cs_agents`（`is_active`）。管理侧函数用 `isAdmin()` 再过滤一次，坐席口令进不了管理接口。
3. **工单锁**：`cs_agent_claim` 检查 `assignee_id` 是否为空，非空且不等于自己 → `claimed_by_other`，实现互斥认领。

### 4.2 限流与防爆破

| 维度 | 阈值 | 位置 | 问题 |
| --- | --- | --- | --- |
| 前端发送 | 1 秒间隔 / 10 条/分钟 | `app.js` `RATE` | 可绕过（直接调接口） |
| 服务端发送 | 12 条/分钟/访客 | `cs_guest_append` | 内存遍历计算，无 IP/全局维度 |
| 登录爆破 | 同口令 5 次、全局 20 次 / 10 分钟 | `cs_console_login` | **无 IP 维度 → 可被用来把所有人锁死（R6）** |
| 分析查询 | 无 | — | 阶段2 必须新增 |

### 4.3 SSE 流式

`POST /api/chat` 写 `text/event-stream`，按 3 字/片、间隔 18ms 推送，末帧 `finish_reason: stop` + `data: [DONE]`。客户端 `config.js` 用 `fetch` + `ReadableStream` 解析 `\n\n` 分帧，透传 `AbortController.signal`——"停止生成"走 abort，服务端靠 `req.aborted` / `res.close` 感知后停止推送。**无心跳、无超时、无背压**，上 Nginx 必须 `proxy_buffering off`。

### 4.4 模型调用（两个旁路 + 一条主链路）

都收敛在同一个 `/api/chat`，服务端靠 system 提示词里的特征串分流：

| 场景 | 判别依据 | 触发条件 |
| --- | --- | --- |
| 意图分类 | system 含「意图分类器」 | 规则置信度 < 0.6 时（`app.js` `detectIntent`） |
| 长会话摘要 | system 含「会话摘要助手」 | 有效消息 > 12 条且距上次摘要 ≥ 6 条 |
| 正常应答 | 其余 | 每轮对话 |

**这是最脆弱的一处耦合（R7）**：阶段2 要"复用这两个入口、不新建通道"，就必须先把分流从"猜提示词"改成显式 `task` 字段，否则分析 Agent 一接进来三个场景会互相串味。

---

## 五、原有链路可用性复核（对照硬性约束 1）

已用真实浏览器（Chrome CDP）跑通，不是纸面推演：

| 环节 | 落地位置 | 结果 |
| --- | --- | --- |
| 对话问答 | `app.js send()` → `cs_guest_append` → `/api/chat` | ✅ 流式、可停止 |
| 意图标签 | `kb.js detectByRules` + 模型兜底 | ✅ 显示「意图 · 查询订单」 |
| FAQ 命中 | `kb.js retrieveFaq`（关键词长度加权 + 二元组重合） | ✅ 气泡「FAQ 命中 3 条」 |
| 订单实时查询 | `cs_lookup_order` → 提示词 → 应答引用 | ✅ 状态/承运/运单号/预计送达准确，无编造 |
| 转人工 | `cs_guest_update(status=handoff)` | ✅ 状态栏切「人工客服接入中…」，非工作时间出留言表单 |
| 坐席登录 + 队列 | `cs_console_login` → `cs_agent_queue` | ✅ 「待接入 1」，等待计时正常 |
| 接入加锁 | `cs_agent_claim` | ✅ 客服B 再点 → 「该工单已被其他客服接入」 |
| 回复署名 | `cs_agent_reply` 写 `meta.agent_name` | ✅ 用户端显示「人工客服 · 客服A」 |
| 标记解决 | `cs_agent_resolve` | ✅ 用户端收到「本会话已由人工客服 客服A 处理完毕」 |
| 5 星评价 | `cs_guest_rate` | ✅ 星星卡 → 「感谢评价：5 星」 |
| 管理看板 | `cs_admin_stats` | ✅ KPI / 满意度分布 / 意图分布 / 14 天趋势 |
| 知识缺口 + CSV | `cs_admin_gaps` / `cs_admin_export` | ✅ 缺口按次数聚合；导出 4 行消息 |

**结论：链路完整可用，改造必须保证这 12 个环节在阶段2–5 每一步之后都不回退。**

---

## 六、改造风险点

### P0（进入阶段2 前建议处理）

| 编号 | 风险 | 后果 | 建议 |
| --- | --- | --- | --- |
| R1 | `data/` **未进 `.gitignore`**，`store.json` 里 `admin_code` 与坐席口令是明文 | 一旦首次提交，口令随仓库外泄；且数据文件入库后每次运行都产生脏 diff | 阶段3 一并补 `.gitignore`：`data/`、`*.log`、`tmp/`；同时把口令改为只读环境变量或加盐哈希 |
| R2 | 访客身份 = 前端 `localStorage` 的 `guest_key`，服务端只信这个字符串 | 拿到 key 即可读该访客全部会话；换设备即丢历史 | 演示可接受；生产建议加 HttpOnly Cookie 或签名 token（阶段3 评估，非必须） |
| R3 | `cs_lookup_order` 公开无鉴权，订单号形如 `A2024001` 可枚举 | 可批量拉取订单金额/物流 | 阶段2 加"每 IP / 每访客 20 次/分钟"限流即可，不阻断演示 |

### P1（改造中必须设计进去）

| 编号 | 风险 | 说明 |
| --- | --- | --- |
| R4 | JSON 全量读写 | 每次写操作 `JSON.stringify` 全库 + 同步落盘，消息量上万后单次写变慢；**无文件锁，多进程/多实例会互相覆盖** → 阶段6 只能起 1 个 systemd 实例（或引入 `proper-lockfile`） |
| R5 | 统计全内存全表扫描 | `cs_admin_stats`/`gaps`/`export` 每次遍历所有会话与消息。分析 Agent 若允许任意时间范围聚合，必须先做单次快照 + 预聚合，禁止逐次全表重扫 |
| R6 | 防爆破无 IP 维度 | 全局 20 次阈值可被攻击者故意打满，导致管理员也进不来（可用性 DoS）。阶段2 加分析查询限流时一并把登录限流改成「IP+口令」双维度 |
| R7 | 模型入口靠提示词特征串分流 | 见 4.4。阶段2 第一件事：`/api/chat` 收显式 `task`（`answer` / `classify` / `summary` / `analytics`），无 `task` 时按旧特征串兜底（向后兼容 Pages 版） |
| R8 | SSE 无心跳/超时/背压 | 阶段4 加心跳注释帧与空闲超时；阶段6 Nginx 必须 `proxy_buffering off; proxy_read_timeout 300s` |
| R9 | `404.html` 硬编码子路径 `/kubao-support-agent/` | 换部署目录或裸 IP 访问时回跳路径可能不准（现逻辑兜底为 `/`，尚可），阶段3 改为按 `location` 推导 |

### P2（记录，不阻断）

- **R10 无测试**：目前只有我手工跑的冒烟脚本与 CDP 脚本，不在仓库内。阶段8 需落成 `test/` 下的可重复用例。
- **R11 时区口径**：统计日期按 UTC+8 手工偏移；但营业时间判断在前端（`isBusinessHours`），服务端无此概念。阶段2 统计"未解决工单"若要看营业时间维度，需在服务端实现。
- **R12 意图枚举固定 4 类**：`refund/order/tech/other`。分析维度想扩展（如"催发货""发票"）需先扩 `kb.js` 规则与 `kb.js` 的提示词，属跨端改动，阶段2 仅做聚合不做扩容。
- **R13 `message_count` 可能漂移**：两条写入路径各自 +1，删会话无级联；不影响展示，迁移 PostgreSQL 时以 `count(messages)` 为准重算。
- **R14 无 CORS 配置**：同源部署无碍；阶段3 要求"跨域跟随环境"，需在 `server.js` 加白名单中间件。
- **R15 `.github/workflows/deploy-pages.yml` 仍是旧语义**（云服务域名校验说明），阶段7 要改为纯静态前端发布。

---

## 七、兼容边界（阶段2–5 的红线）

1. **`app.js` / `admin.js` / `kb.js` 不改**。因此：
   - `cs_admin_stats` 的既有字段一个都不能删改（`total_conversations`、`total_messages`、`today_conversations`、`rated_count`、`avg_score`、`satisfied_rate`、`handoff_count`、`pending_handoff`、`score_dist`、`intent_counts[]`、`daily[].{day,conversations,rated,avg_score}`）——只能**追加**新字段。
   - `cs_agent_queue` 的 `waiting/mine/others/resolved_today` 结构固定，行内 `wait_seconds` 是排序与标色依据。
   - 新增能力一律走**新 RPC 名 + 新端点**，不复用旧名改语义。
2. **`unwrapRpc` 契约**：新接口失败也必须回 `{ok:false, error:'可读中文或已映射错误码'}`，不能抛堆栈。
3. **提示词格式是跨端契约**：`kb.js buildSystemPrompt` 产出的 FAQ 块（`[n] 问题：… 回答：…`）与订单块（`- 订单号：…`）被 `reply.js` 正则解析。改格式必须两端同步。
4. **Pages 静态版**：`app.js`/`admin.js` 用 `location.hostname` 是否为 `*.github.io` 判断静态预览模式，因此**阶段7 的"环境变量区分"要么注入全局变量、要么保留该域名判断**，不能直接删掉现有逻辑。
5. **`schema.sql` 是迁移契约**：`rpc.js` 新增函数时，阶段8 需同步补 PostgreSQL 版本，保持同名同参同返回。

---

## 八、与 8 阶段目标的差距（GAP）

| 阶段 | 现状 | 需要新增 | 改动面 |
| --- | --- | --- | --- |
| 2 数据分析 Agent | 只有固定聚合（`cs_admin_stats`） | 自然语言 → 结构化查询 DSL → 只读执行器；6 类统计口径；分析专用限流；`task` 分流 | 新增 `server/analytics/*`、2–3 个 RPC、改 `server.js` 路由与 `reply.js` 分流 |
| 3 多环境配置 | 单一 `.env.example`，无环境概念 | `config/` 分层（dev/test/prod）、环境变量矩阵、CORS/日志级别/限流阈值/静态路径随环境切换 | 新增 `server/config.js`，改 `server.js` 启动段、`assets/config.js` 注入模式 |
| 4 日志与链路 | 只有 `console.error` 兜底 | 结构化 JSON 日志（traceId/接口/耗时/状态/模型耗时/限流命中/锁变更）、分级、异常中间件、`/health` | 新增 `server/logger.js` + 中间件，改 `server.js`、`rpc.js` 埋点 |
| 5 看板升级 | 已有 KPI/满意度/意图/趋势 | 钻取：工单量趋势（可切维度）、意图饼图、坐席绩效（接单/首响/解决率/好评率）、知识缺口高频 | 新增聚合 RPC（坐席绩效需 `claimed_at`→首条 agent 消息的时间差）+ `admin.html` 追加容器 + `admin.js` 追加渲染 |
| 6 服务器部署 | 无 | 打包脚本、Nginx（域名 HTTPS + 裸 IP）、systemd、`/opt/kubao-support` 规划、备份回滚 | 新增 `deploy/`，**只生成不执行** |
| 7 Pages 静态版 | 有域名判断、链路独立 | 模式开关同源化，保持旧链接不变 | 改 `assets/config.js` 一处判断 + workflow 说明 |
| 8 收尾 | README 已补本地版说明 | 完整 README（架构图/接口文档）、自测用例、PG 迁移步骤 | 新增 `test/`、`docs/` |

关键判断：**阶段2 是全局难点**，因为它同时要（a）不碰前端、（b）复用现有模型入口、（c）只读不写、不走 SQL 拼接。建议先把 `task` 分流和"查询 DSL 白名单"这两件事做掉，再谈自然语言解析。

---

## 九、阶段 1 结论

1. **可改造性：高**。前端零构建、后端零依赖、接口层已抽象成 RPC 名，新增能力是"加法"而非"重写"。
2. **必须先修的三个坑**：R1（`data/` 入库 + 明文口令）、R7（模型入口靠猜提示词）、R4（单实例约束，否则部署阶段会踩）。
3. **前端不动的代价**：新增统计只能"追加字段"，看板新图表必须新增 DOM 容器与独立渲染函数，不能改造现有 `renderStats` 的入参结构——这是阶段5 的主要工作量。
4. **仓库状态**：当前目录**不是 git 仓库**（源码来自压缩包），硬性约束 6 的分支规范尚未建立，需要先 `git init` 并建立 `main` / `dev` / `feature/*`。命令已列在下方，**等你确认后再执行**。

---

## 十、待你确认的三件事

1. **git 初始化与分支建立**（命令见回复正文，未执行）。
2. **`data/` 是否立即加入 `.gitignore`**：建议"是"；若不希望动，至少确认不提交 `data/store.json`。
3. **阶段2 自然语言查询的解析策略**：当前环境没有真实大模型通道，建议"规则解析为主（指标/维度/时间范围关键词字典）+ 预留 `task=analytics` 的模型兜底位"，这样即使不接模型也能跑通全部 6 类统计，接上模型后再提升长尾表达理解。若你要求必须走模型，需要先补模型凭据。
