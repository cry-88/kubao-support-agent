/**
 * 集成测试：真起一个进程，用 HTTP 打真实接口
 * 覆盖：原有链路不回退 + task 分流 + 分析查询权限/限流 + 两种 CSV 导出
 *
 * 说明：用独立的临时数据目录与端口，不碰开发数据、不占用 8080。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 18123;
const BASE = 'http://127.0.0.1:' + PORT;
const ADMIN = 'test-admin-code';
const DATA_DIR = path.join(os.tmpdir(), 'kubao-test-' + Date.now());

let child = null;
let LOG_BUF = '';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function rpc(name, params) {
  const res = await fetch(BASE + '/api/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, params }),
  });
  const j = await res.json();
  return j.data;
}

async function chat(body) {
  const res = await fetch(BASE + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let out = '';
  for (const block of text.split('\n\n')) {
    const line = block.trim();
    if (line.indexOf('data:') !== 0) continue;
    const p = line.slice(5).trim();
    if (p === '[DONE]') break;
    const j = JSON.parse(p);
    const d = j.choices && j.choices[0] && j.choices[0].delta;
    if (d && d.content) out += d.content;
  }
  return { status: res.status, body: text, text: out };
}

test.before(async () => {
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      NODE_ENV: 'test',
      CS_DATA_DIR: DATA_DIR,
      CS_ADMIN_CODE: ADMIN,
      CS_ANALYTICS_RATE: '6',
      CS_CORS_ORIGINS: 'http://allowed.test',
      CS_LOG_LEVEL: 'info',
      CS_LOG_FORMAT: 'json',
      CS_BODY_LIMIT_BYTES: '4096',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    LOG_BUF += d;
  });
  child.stderr.on('data', (d) => {
    LOG_BUF += d;
  });
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(BASE + '/api/models');
      if (r.ok) return;
    } catch (e) {
      /* 等待启动 */
    }
    await sleep(200);
  }
  throw new Error('服务未能启动');
});

test.after(() => {
  if (child) child.kill();
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch (e) {
    /* 忽略 */
  }
});

const GUEST = 'testguest0000000000000001';
let CONV_ID = null;

test('原有链路①：建会话并写入订单提问', async () => {
  const start = await rpc('cs_guest_start', { p_guest_key: GUEST, p_user_label: '访客 T1' });
  assert.strictEqual(start.ok, true);
  CONV_ID = start.conversation_id;

  const append = await rpc('cs_guest_append', {
    p_guest_key: GUEST,
    p_conversation_id: CONV_ID,
    p_role: 'user',
    p_content: '我的订单 A2024001 到哪了？',
    p_intent: 'order',
    p_meta: { score: 0.85, source: 'rules', faq_miss: false },
  });
  assert.strictEqual(append.ok, true);

  const order = await rpc('cs_lookup_order', { p_order_no: 'A2024001' });
  assert.strictEqual(order.status, '已签收');
});

test('原有链路②：不带 task 的对话（旧路径）仍然正常', async () => {
  const system = '本轮系统判定的用户意图：查询订单（order）。\n可参考的 FAQ 知识库条目（优先采用；若与用户问题无关则忽略，绝不编造未提供的事实）：\n（本轮未检索到匹配的 FAQ 条目）\n系统实时查询到的订单信息（可直接引用，不要改写数字）：\n- 订单号：A2024001\n- 商品：轻氧空气净化器 Pro\n- 状态：已签收\n- 快递：顺丰速运 SF1234567890123\n';
  const r = await chat({ model: 'kubao-local-reply', messages: [{ role: 'system', content: system }, { role: 'user', content: '我的订单 A2024001 到哪了' }] });
  assert.strictEqual(r.status, 200);
  assert.match(r.text, /已签收/);
  assert.match(r.text, /SF1234567890123/);
});

test('原有链路③：显式 task=answer 与旧路径同结果', async () => {
  const system = '本轮系统判定的用户意图：退款（refund）。\n可参考的 FAQ 知识库条目（优先采用；若与用户问题无关则忽略，绝不编造未提供的事实）：\n[1] 问题：如何申请退款？\n    回答：进入「我的订单」点击「申请退款」即可。\n';
  const messages = [{ role: 'system', content: system }, { role: 'user', content: '怎么申请退款' }];
  const legacy = await chat({ messages });
  const explicit = await chat({ task: 'answer', messages });
  assert.strictEqual(explicit.text, legacy.text);
  assert.match(explicit.text, /申请退款/);
});

test('task 分流：classify / summary 与旧提示词路径一致', async () => {
  const cls = await chat({
    task: 'classify',
    messages: [
      { role: 'system', content: '你是精确的意图分类器，只输出 JSON，不要输出任何其它内容。' },
      { role: 'user', content: '用户消息：支付失败，是不是扣了两次钱' },
    ],
  });
  const parsed = JSON.parse(cls.text);
  assert.strictEqual(parsed.intent, 'tech');

  const sum = await chat({
    task: 'summary',
    messages: [
      { role: 'system', content: '你是会话摘要助手。' },
      { role: 'user', content: '用户：订单 A2024001 到哪了\n客服：已签收。' },
    ],
  });
  assert.match(sum.text, /A2024001/);
});

test('task 分流：非法 task 明确拒绝', async () => {
  const r = await fetch(BASE + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task: 'rm -rf', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.strictEqual(r.status, 400);
  const j = await r.json();
  assert.match(j.error.message, /不支持的任务类型/);
});

test('分析权限：无口令访问 task=analytics 被 403 拦下', async () => {
  const r = await fetch(BASE + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task: 'analytics', messages: [{ role: 'user', content: '近 7 天工单量趋势' }] }),
  });
  assert.strictEqual(r.status, 403);
});

test('分析权限：RPC 用坐席口令访问分析接口被拒', async () => {
  const r = await rpc('cs_admin_analytics', { p_code: 'kubao-agent-1', p_query: '近 7 天工单量趋势' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'unauthorized');
});

test('分析：自然语言查询走通，返回结构化结果与可解释信息', async () => {
  const r = await rpc('cs_admin_analytics', { p_code: ADMIN, p_query: '近 7 天工单量趋势' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.metric, 'ticket_trend');
  assert.strictEqual(r.rows.length, 7);
  assert.strictEqual(r.read_only, true);
  assert.ok(r.query.confidence > 0.5);
  assert.strictEqual(r.query.dsl.metric, 'ticket_trend');
  assert.ok(r.summary.length > 0);
});

test('分析：结构化 DSL 直传（跳过自然语言）', async () => {
  const r = await rpc('cs_admin_analytics', {
    p_code: ADMIN,
    p_dsl: { metric: 'rating_dist', days: 30 },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.rows.length, 5);
});

test('分析：听不懂的问法给出建议而不是乱查', async () => {
  const r = await rpc('cs_admin_analytics', { p_code: ADMIN, p_query: '你们公司地址在哪' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'unparsed');
  assert.ok(r.suggestions.length >= 5);
});

test('分析：非法 DSL 被白名单拒绝', async () => {
  const r = await rpc('cs_admin_analytics', { p_code: ADMIN, p_dsl: { metric: 'drop_table' } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'invalid_dsl');
});

test('分析 meta：指标清单可读', async () => {
  const r = await rpc('cs_admin_analytics_meta', { p_code: ADMIN });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.metrics.length, 8);
});

test('导出：dataset=analytics 走 CSV，含 BOM 与文件名', async () => {
  const r = await rpc('cs_admin_export', { p_code: ADMIN, p_dataset: 'analytics', p_query: '各意图标签占比' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.dataset, 'analytics');
  assert.ok(r.csv.startsWith('\ufeff'));
  assert.match(r.filename, /\.csv$/);
  assert.ok(r.row_count >= 1);
});

test('导出：不带 p_dataset 的旧调用行为不变（逐条消息）', async () => {
  const r = await rpc('cs_admin_export', { p_code: ADMIN, p_status: 'all' });
  assert.strictEqual(r.ok, true);
  assert.ok(Array.isArray(r.items));
  assert.ok(r.items.length >= 2);
  assert.ok(Object.prototype.hasOwnProperty.call(r.items[0], 'conversation_id'));
});

test('环境：runtime-config 可读且不含密钥', async () => {
  const r = await fetch(BASE + '/api/runtime-config');
  assert.strictEqual(r.status, 200);
  const j = await r.json();
  assert.strictEqual(j.ok, true);
  assert.strictEqual(j.env, 'test');
  assert.strictEqual(j.features.analytics, true);
  const raw = JSON.stringify(j);
  assert.doesNotMatch(raw, /admin_code|api_key/i);
  assert.ok(!raw.includes(ADMIN), '不得回显管理员口令');
});

test('CORS：白名单来源放行预检，未命中来源被拒', async () => {
  const okRes = await fetch(BASE + '/api/rpc', {
    method: 'OPTIONS',
    headers: { Origin: 'http://allowed.test', 'Access-Control-Request-Method': 'POST' },
  });
  assert.strictEqual(okRes.status, 204);
  assert.strictEqual(okRes.headers.get('access-control-allow-origin'), 'http://allowed.test');
  assert.ok((okRes.headers.get('access-control-allow-methods') || '').includes('POST'));

  const badRes = await fetch(BASE + '/api/rpc', {
    method: 'OPTIONS',
    headers: { Origin: 'http://evil.test', 'Access-Control-Request-Method': 'POST' },
  });
  assert.strictEqual(badRes.status, 403);
  assert.strictEqual(badRes.headers.get('access-control-allow-origin'), null);
});

test('CORS：未命中来源的普通请求不写放行头', async () => {
  const r = await fetch(BASE + '/api/models', { headers: { Origin: 'http://evil.test' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('access-control-allow-origin'), null);
});

test('404 兜底：返回 404 状态 + 兜底页面（不是软 404）', async () => {
  const r = await fetch(BASE + '/definitely-not-here');
  assert.strictEqual(r.status, 404);
  assert.match(r.headers.get('content-type') || '', /text\/html/);
  const html = await r.text();
  assert.match(html, /404/);
});

test('静态资源：正常返回，HTML 不缓存', async () => {
  const js = await fetch(BASE + '/assets/config.js');
  assert.strictEqual(js.status, 200);
  assert.match(js.headers.get('content-type') || '', /javascript/);
  assert.strictEqual(js.headers.get('cache-control'), 'no-cache');

  const html = await fetch(BASE + '/index.html');
  assert.strictEqual(html.status, 200);
  assert.match(html.headers.get('cache-control') || '', /no-store/);
});

test('安全：服务端源码 / 数据 / 环境配置目录不可通过静态访问', async () => {
  for (const p of ['/server/config.js', '/data/store.json', '/env/production.env', '/.env', '/test/http.test.js']) {
    const r = await fetch(BASE + p);
    assert.strictEqual(r.status, 404, p + ' 应被拦截');
  }
});

/* ------------------------- 阶段4：健康检查 / 链路 / 日志 ------------------------- */

async function waitForLog(needle, ms) {
  const deadline = Date.now() + (ms || 2000);
  while (Date.now() < deadline) {
    if (LOG_BUF.indexOf(needle) >= 0) return true;
    await sleep(50);
  }
  return false;
}

test('健康检查：返回 200、状态 ok，且不泄露路径与口令', async () => {
  const r = await fetch(BASE + '/health');
  assert.strictEqual(r.status, 200);
  const j = await r.json();
  assert.strictEqual(j.status, 'ok');
  assert.strictEqual(j.env, 'test');
  assert.strictEqual(j.checks.data_dir.writable, true);
  assert.strictEqual(j.checks.store.ok, true);
  assert.ok(j.counts.conversations >= 1);
  assert.ok(typeof j.uptime_s === 'number');
  const raw = JSON.stringify(j);
  assert.ok(!raw.includes(ADMIN), '不得回显管理员口令');
  assert.ok(!raw.includes(DATA_DIR), '不得暴露绝对路径');
});

test('链路追踪：响应头带 X-Trace-Id，并复用调用方传入的 X-Request-Id', async () => {
  const auto = await fetch(BASE + '/api/models');
  const autoTrace = auto.headers.get('x-trace-id');
  assert.match(autoTrace || '', /^[a-z0-9]{8,32}$/);

  const given = 'trace-from-nginx-0001';
  const echoed = await fetch(BASE + '/api/models', { headers: { 'X-Request-Id': given } });
  assert.strictEqual(echoed.headers.get('x-trace-id'), given);
  assert.ok(await waitForLog(given), '日志里应带上调用方传入的 trace_id');
});

test('非法 JSON：400 + 可读提示，不返回堆栈', async () => {
  const r = await fetch(BASE + '/api/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not-json',
  });
  assert.strictEqual(r.status, 400);
  const text = await r.text();
  assert.match(text, /请求格式错误/);
  assert.doesNotMatch(text, /at Object|at Module|SyntaxError|\.js:\d+/);
});

test('请求体超限：413 + 可读提示', async () => {
  const r = await fetch(BASE + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(8000) }] }),
  });
  assert.strictEqual(r.status, 413);
  const j = await r.json();
  assert.match(j.error.message, /超过上限/);
});

test('访问日志：含 event/http.request/status/duration_ms/trace_id', async () => {
  await fetch(BASE + '/api/runtime-config');
  assert.ok(await waitForLog('"event":"http.request"'));
  const lines = LOG_BUF.split('\n').filter((l) => l.indexOf('"event":"http.request"') >= 0);
  assert.ok(lines.length > 0);
  const obj = JSON.parse(lines[lines.length - 1]);
  assert.strictEqual(obj.level, 'info');
  assert.ok(obj.path);
  assert.ok(typeof obj.status === 'number');
  assert.ok(typeof obj.duration_ms === 'number');
  assert.ok(obj.trace_id);
});

test('RPC 调用日志：记录接口名、结果与耗时', async () => {
  await rpc('cs_guest_list', { p_guest_key: 'testguest0000000000000009' });
  assert.ok(await waitForLog('"event":"rpc.call"'));
  const lines = LOG_BUF.split('\n').filter((l) => l.indexOf('"event":"rpc.call"') >= 0);
  const obj = JSON.parse(lines[lines.length - 1]);
  assert.strictEqual(obj.fn, 'cs_guest_list');
  assert.strictEqual(obj.result, 'ok');
  assert.ok(typeof obj.duration_ms === 'number');
  assert.ok(obj.trace_id, 'RPC 日志应继承请求 trace');
});

test('登录失败：写 warn 级 auth.login 日志且口令被打码', async () => {
  await rpc('cs_console_login', { p_code: 'definitely-wrong-code' });
  assert.ok(await waitForLog('"event":"auth.login"'));
  const lines = LOG_BUF.split('\n').filter((l) => l.indexOf('"event":"auth.login"') >= 0);
  const obj = JSON.parse(lines[lines.length - 1]);
  assert.strictEqual(obj.level, 'warn');
  assert.strictEqual(obj.result, 'fail');
  assert.strictEqual(obj.reason, 'bad_code');
  assert.doesNotMatch(lines[lines.length - 1], /definitely-wrong-code/);
});

test('工单锁冲突：写 warn 级 ticket.claim result=conflict', async () => {
  const start = await rpc('cs_guest_start', { p_guest_key: 'lockguest00000000000000001', p_user_label: '锁测试' });
  await rpc('cs_guest_update', {
    p_guest_key: 'lockguest00000000000000001',
    p_conversation_id: start.conversation_id,
    p_status: 'handoff',
  });
  const first = await rpc('cs_agent_claim', { p_code: 'kubao-agent-1', p_conversation_id: start.conversation_id });
  assert.strictEqual(first.ok, true);
  const second = await rpc('cs_agent_claim', { p_code: 'kubao-agent-2', p_conversation_id: start.conversation_id });
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.error, 'claimed_by_other');

  assert.ok(await waitForLog('"result":"conflict"'));
  const lines = LOG_BUF.split('\n').filter((l) => l.indexOf('"event":"ticket.claim"') >= 0);
  const obj = JSON.parse(lines[lines.length - 1]);
  assert.strictEqual(obj.level, 'warn');
  assert.strictEqual(obj.result, 'conflict');
  assert.strictEqual(obj.conversation_id, start.conversation_id);
});

test('看板聚合接口：管理员一次拿到四块数据', async () => {
  const r = await rpc('cs_admin_dashboard', { p_code: ADMIN, p_days: 14 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.days, 14);
  assert.strictEqual(r.read_only, true);
  assert.strictEqual(r.trend.rows.length, 14);
  assert.ok(r.intent && Array.isArray(r.intent.rows));
  assert.ok(r.agents && Array.isArray(r.agents.rows));
  assert.ok(r.gaps && Array.isArray(r.gaps.rows));
  assert.ok(r.generated_at);
});

test('看板聚合接口：坐席口令被拒（不消耗分析额度）', async () => {
  const r = await rpc('cs_admin_dashboard', { p_code: 'kubao-agent-1', p_days: 14 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'unauthorized');
});

test('分析限流：超过阈值返回可读提示（阈值由 CS_ANALYTICS_RATE 控制）', async () => {
  let blocked = null;
  for (let i = 0; i < 12; i += 1) {
    const r = await rpc('cs_admin_analytics', { p_code: ADMIN, p_query: '评价分布' });
    if (r.ok === false && r.code === 'rate_limited') {
      blocked = r;
      break;
    }
  }
  assert.ok(blocked, '连续查询应当触发限流');
  assert.match(blocked.error, /太频繁/);
});
