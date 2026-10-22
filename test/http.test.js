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
      CS_DATA_DIR: DATA_DIR,
      CS_ADMIN_CODE: ADMIN,
      CS_ANALYTICS_RATE: '6',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
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
