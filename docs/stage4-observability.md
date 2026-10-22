# 阶段 4 · 结构化日志、异常收敛、链路追踪与健康检查

> 交付：JSON 行日志 + traceId 全链路 + 分级 + 脱敏 + 异常统一收敛 + `GET /health`
> 前端业务文件依旧零改动；`assets/*.js` 一个字符都没动。

---

## 一、日志：从"字符串"到"事件"

### 1.1 两种格式，按环境切

| 环境 | 默认格式 | 默认等级 | 堆栈 |
| --- | --- | --- | --- |
| development | `text`（可读） | `debug` | 输出 |
| test | `text` | `warn` | 输出 |
| production | `json`（一行一事件） | `info` | 不输出 |

```
# text（开发）
2026-10-22T14:09:26.442Z INFO  [http] 请求完成 event=http.request method=GET path=/health status=200 duration_ms=3.1 remote_addr=127.0.0.1 trace=e84229d0cbaa4ae5

# json（生产）
{"ts":"2026-10-22T14:09:27.463Z","level":"warn","module":"rpc","msg":"登录失败","event":"auth.login","result":"fail","reason":"bad_code","code_failures":1,"limit_per_code":5,"trace_id":"manual-trace-042"}
```

为什么生产用 JSON：日志最终进 journald / 采集器，一行一事件才能被 `jq`、Loki、ES 稳定解析；文本格式留给本地肉眼调试。

### 1.2 字段约定

| 字段 | 含义 |
| --- | --- |
| `ts` | ISO 时间戳 |
| `level` | debug / info / warn / error |
| `module` | 产生日志的模块（store / http / rpc / analytics），`child()` 会拼成 `rpc:inner` |
| `msg` | 人读的一句话 |
| `trace_id` | 链路 id（请求上下文内自动带） |
| `event` | 事件名，机器检索的主键 |
| `result` | ok / fail / reject / conflict / limited / error |
| `duration_ms` | 耗时（保留 1 位小数） |

### 1.3 事件清单

| event | 等级 | 关键字段 | 说明 |
| --- | --- | --- | --- |
| `http.request` | info | method / path / status / duration_ms / remote_addr / aborted | 每个请求一条，取代 access log |
| `http.start` | debug | method / path | 请求进入 |
| `http.error` | error | where / method / path / err | 未预料异常（堆栈只进日志） |
| `http.client_error` | warn | code | 客户端提前断连 |
| `rpc.call` | info（轮询类 debug） | fn / result / duration_ms / conversation_id / guest(打码) / error | 每次 RPC 一条 |
| `auth.login` | info（成功）/ warn（失败） | result / reason / code_failures / operator_name / is_admin | 登录审计 |
| `auth.lockout` | error | scope(global\|code) / failures / window_minutes | 触发防爆破锁定 |
| `ticket.claim` | info / warn(conflict) | conversation_id / operator_id / held_by | 认领、锁冲突 |
| `ticket.auto_claim` | info | conversation_id / operator_id | 回复时自动认领 |
| `ticket.release` | info / warn | conversation_id / operator_id | 释放回队列 |
| `ticket.resolve` | info | conversation_id / via(agent\|admin) / resolved | 标记解决 |
| `rate_limit` | warn | scope(chat\|analytics) / limit_per_minute / retry_after_s | 限流命中 |
| `model.call` | info / error | task / duration_ms / chars / history | 每次应答生成 |
| `analytics.query` | info / warn | actor / status / duration_ms / metric / q | 分析查询审计（问句截断 80 字） |
| `store.load` / `store.seed` / `store.load_failed` / `store.save_failed` | debug / info / error | conversations / messages / err | 数据面读写 |

**轮询接口降噪**：`cs_guest_poll`、`cs_agent_queue` 是 4 秒 / 10 秒级的轮询，调用日志降到 `debug`，生产（info）不会刷屏——这是刻意的取舍，不是漏埋点。

---

## 二、链路追踪：不用改业务代码

- 入口生成 `traceId`（16 位十六进制），或**复用调用方传入的 `X-Request-Id`**（便于和 Nginx 日志对上）。
- 用 `AsyncLocalStorage` 存上下文，一个请求内的所有异步链路（RPC → 分析 → 存储）写日志时自动带上 `trace_id`，不需要函数层层传参。
- 响应头回写 `X-Trace-Id`，前端/运维拿到这个 id 就能反查整条链路。

```bash
curl -H 'X-Request-Id: manual-trace-042' http://localhost:8080/api/models -D -
# X-Trace-Id: manual-trace-042
```

```bash
# 按 trace 还原一次请求
grep 'trace_id":"manual-trace-042"' server.log | jq -c '{ts,module,event,msg,result}'
```

---

## 三、异常收敛：前端永远只看到人话

| 场景 | HTTP | 返回体 | 日志 |
| --- | --- | --- | --- |
| 请求体不是合法 JSON | 400 | `{"error":{"message":"请求格式错误"}}` | debug 级 http.request（status=400） |
| 请求体超限 | 413 | `{"error":{"message":"请求体超过上限（N 字节）"}}` | 同上 |
| 未知 RPC 函数 | 200 | `{"data":{"ok":false,"error":"unknown function: X"}}` | warn `rpc.call` result=reject |
| 业务校验失败（如口令错） | 200 | `{"data":{"ok":false,"error":"unauthorized"}}` | warn `rpc.call` + 业务事件 |
| 函数内部抛异常 | 200 | `{"data":{"ok":false,"error":"服务端异常，请稍后重试"}}` | error `rpc.call` result=error，带堆栈 |
| 未捕获异常（同步/异步） | 500 | `{"error":{"message":"服务暂时不可用，请稍后重试","trace_id":"..."}}` | error `http.error` |
| 进程级 uncaughtException | — | — | error 后退出（exitCode=1），不假装健康 |

要点：

1. **堆栈不进响应体**，只进日志；响应里带 `trace_id` 方便用户报障时对齐。
2. 请求体超限不再 `req.destroy()`——原先那样做客户端只会看到连接重置，拿不到 413。现在读完剩余字节再回 413，并带 `Connection: close`。
3. `uncaughtException` 记录后主动退出，交由 systemd 拉起（阶段6），而不是带病继续跑。

---

## 四、健康检查 `GET /health`

```json
{
  "status": "ok",
  "service": "kubao-support",
  "version": "1.4.0",
  "env": "development",
  "uptime_s": 7,
  "node": "v22.22.2",
  "memory_mb": 52,
  "checks": {
    "config": { "ok": true, "env": "development" },
    "data_dir": { "ok": true, "writable": true, "error": null },
    "store": { "ok": true, "loaded": true, "seeded": true, "load_error": null, "save_error": null, "last_save_at": "..." }
  },
  "counts": { "conversations": 0, "messages": 0, "faqs": 12 },
  "time": "..."
}
```

| 状态码 | 含义 |
| --- | --- |
| 200 | 全部检查通过 |
| 503 | 任一检查失败（数据目录不可写、store 读写报错） |

**刻意不返回**：绝对路径、管理员/坐席口令、任何密钥。`data_dir` 只暴露"可写/不可写"和错误码。

`/health` 不走鉴权——它是给探针用的，且不含敏感信息。Nginx / 云监控直接打这个地址即可。

---

## 五、脱敏

这些键名出现在日志字段里时自动替换为 `[redacted]`：

```
code, p_code, authCode, auth_code, password, passwd, token,
authorization, api_key/apikey, secret, guest_key
```

另外：`guest_key` 在 RPC 日志里额外做 `前6位***` 处理（它相当于访客凭证，泄露即可读取该访客全部会话）；问句类字段截断 80 字，长文本截断 400 字。

---

## 六、测试（94 条全绿，新增 20 条）

| 文件 | 数量 | 覆盖 |
| --- | --- | --- |
| `test/logger.test.js`（新） | 12 | 等级过滤、JSON 字段、文本格式、trace 跨异步传递、无上下文不写 trace、6 类敏感键脱敏、堆栈开关、超长截断、`must()`、`timer()`、traceId 唯一性、非法配置忽略 |
| `test/http.test.js`（追加） | 8 | `/health` 200 且不含口令与绝对路径、`X-Trace-Id` 生成与复用、非法 JSON 400 无堆栈、超限 413、`http.request` 日志字段、`rpc.call` 日志继承 trace、登录失败 warn 且口令未落日志、工单锁冲突 warn 且带 conversation_id |

日志断言方式：集成测试以 `CS_LOG_FORMAT=json` 启动子进程，收集 stdout，解析 JSON 行后断言字段——不是"看日志像不像"，而是真的在验结构。

---

## 七、取舍与遗留

1. **日志只到 stdout**，不自己写文件。容器/systemd 环境下由 journald 收集是标准做法；自己实现滚动切割容易写出 bug（多进程同时切、磁盘打满）。阶段6 的 systemd 单元里用 `StandardOutput=journal` 即可。
2. **没有采样**。当前量级（单实例、JSON 全量）完全够用；若未来 QPS 上去了，先给 `http.start`（debug）加采样，`http.request` 保留全量。
3. **`remote_addr` 是直连地址**，不是 `X-Forwarded-For`。与阶段3 的判断一致：代理头可信度取决于 Nginx 配置，留到阶段6 一起做，避免现在引入可伪造的 IP。
4. **`trace_id` 不写入业务数据**（消息表不存 trace）。跨"请求"的追踪（比如用户隔天再来）应查 `conversation_id`，那是业务维度，不该和链路 id 混用。
