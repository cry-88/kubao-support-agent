/**
 * 数据分析模块单元测试（零依赖，node --test 运行）
 *   node --test test/
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const dslLib = require('../server/analytics/dsl');
const parseLib = require('../server/analytics/parse');
const execute = require('../server/analytics/execute');
const analytics = require('../server/analytics');
const { createLimiter } = require('../server/analytics/rate');
const { buildDb, dayKey } = require('./fixtures');

const TODAY = '2026-10-22';

function runQuery(rawDsl, db) {
  const n = dslLib.normalize(rawDsl);
  assert.ok(n.ok, 'DSL 应该通过校验：' + JSON.stringify(n));
  const r = execute.run(n.dsl, db, TODAY);
  assert.ok(r.ok, '执行应该成功');
  return r;
}

/* ------------------------------ DSL 白名单 ------------------------------ */

test('DSL：未登记的指标被拒绝，不会执行', () => {
  const r = dslLib.normalize({ metric: 'drop_table' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /不支持的指标/);
});

test('DSL：时间窗与条数上限生效', () => {
  assert.strictEqual(dslLib.normalize({ metric: 'overview', days: 0 }).ok, false);
  assert.strictEqual(dslLib.normalize({ metric: 'overview', days: 400 }).ok, false);
  assert.strictEqual(dslLib.normalize({ metric: 'overview', limit: 999 }).ok, false);
  assert.strictEqual(dslLib.normalize({ metric: 'overview', from: '2026-10-22', to: '2026-10-01' }).ok, false);
});

test('DSL：非法过滤值被拒绝，默认值被补齐', () => {
  assert.strictEqual(dslLib.normalize({ metric: 'unresolved', filters: { status: 'deleted' } }).ok, false);
  assert.strictEqual(dslLib.normalize({ metric: 'unresolved', filters: { intent: 'vip' } }).ok, false);
  const n = dslLib.normalize({ metric: 'ticket_trend' });
  assert.strictEqual(n.ok, true);
  assert.strictEqual(n.dsl.days, 14);
  assert.strictEqual(n.dsl.limit, 20);
  assert.strictEqual(n.dsl.order, 'desc');
  assert.strictEqual(n.dsl.dimension, 'day');
});

/* ------------------------------ 自然语言解析 ------------------------------ */

const CASES = [
  ['近 14 天工单量趋势', 'ticket_trend', (d) => d.days === 14],
  ['最近一周的工单趋势', 'ticket_trend', (d) => d.days === 7],
  ['各意图标签占比', 'intent_share', (d) => !!d],
  ['坐席工作量排行', 'agent_workload', (d) => !!d],
  ['客服绩效怎么样', 'agent_workload', (d) => !!d],
  ['评价分布', 'rating_dist', (d) => !!d],
  ['满意度如何，好评率多少', 'rating_dist', (d) => !!d],
  ['FAQ 命中率怎么样', 'faq_hit_rate', (d) => !!d],
  ['有哪些未解决工单', 'unresolved', (d) => !!d],
  ['高频知识缺口 top5', 'knowledge_gaps', (d) => d.limit === 5],
  ['整体情况汇总一下', 'overview', (d) => !!d],
  ['最近一个月退款的工单趋势', 'ticket_trend', (d) => d.days === 30 && d.filters.intent === 'refund'],
  ['昨天有多少工单', 'ticket_trend', (d) => d.from === dayKey(TODAY, -1) && d.to === dayKey(TODAY, -1)],
];

for (const [text, metric, extra] of CASES) {
  test('解析："' + text + '" → ' + metric, () => {
    const r = parseLib.parse(text, { today: TODAY, agents: [{ name: '客服A' }, { name: '客服B' }] });
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.dsl.metric, metric);
    assert.ok(extra(r.dsl), '附加断言失败：' + JSON.stringify(r.dsl));
  });
}

test('解析：听不懂时明确报错并给出可选问法，不瞎猜指标', () => {
  const r = parseLib.parse('你们公司地址在哪', { today: TODAY });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /没能理解/);
  assert.ok(r.suggestions.length >= 5);
});

test('解析：FAQ 命中率不会被"未命中"抢走', () => {
  const r = parseLib.parse('哪些问题没命中知识库', { today: TODAY });
  assert.strictEqual(r.dsl.metric, 'knowledge_gaps');
});

/* ------------------------------ 统计口径 ------------------------------ */

test('工单量趋势：按天聚合，转人工/已解决分别计数', () => {
  const db = buildDb(TODAY);
  const r = runQuery({ metric: 'ticket_trend', days: 7 }, db);
  assert.strictEqual(r.rows.length, 7);
  assert.strictEqual(r.total, 5);
  const handoff = r.rows.reduce((s, x) => s + x.handoff, 0);
  const closed = r.rows.reduce((s, x) => s + x.closed, 0);
  const rated = r.rows.reduce((s, x) => s + x.rated, 0);
  assert.strictEqual(handoff, 4);
  assert.strictEqual(closed, 3);
  assert.strictEqual(rated, 3);
  const day = r.rows.find((x) => x.day === dayKey(TODAY, -1));
  assert.strictEqual(day.conversations, 3);
  assert.strictEqual(day.handoff, 3);
});

test('意图占比：四类意图计数与百分比', () => {
  const db = buildDb(TODAY);
  const r = runQuery({ metric: 'intent_share', days: 30 }, db);
  assert.strictEqual(r.total, 6);
  const refund = r.rows.find((x) => x.intent === 'refund');
  assert.strictEqual(refund.count, 2);
  assert.strictEqual(refund.pct, 33.3);
  assert.strictEqual(refund.label, '退款');
});

test('坐席工作量：接单、解决率、平均首响、好评率', () => {
  const db = buildDb(TODAY);
  const r = runQuery({ metric: 'agent_workload', days: 30 }, db);
  const a = r.rows.find((x) => x.agent === '客服A');
  assert.strictEqual(a.claimed, 2);
  assert.strictEqual(a.resolved, 2);
  assert.strictEqual(a.resolve_rate, 100);
  assert.strictEqual(a.avg_first_response, 3600);
  assert.strictEqual(a.avg_score, 4);
  assert.strictEqual(a.good_rate, 50);
  const b = r.rows.find((x) => x.agent === '客服B');
  assert.strictEqual(b.claimed, 2);
  assert.strictEqual(b.avg_score, 2.5);
});

test('评价分布：五档齐全，平均分与好评率正确', () => {
  const db = buildDb(TODAY);
  const r = runQuery({ metric: 'rating_dist', days: 30 }, db);
  assert.strictEqual(r.rows.length, 5);
  assert.strictEqual(r.total, 4);
  assert.strictEqual(r.extra.avg_score, 3.25);
  assert.strictEqual(r.extra.satisfied_rate, 50);
  assert.strictEqual(r.rows[0].score, 5);
  assert.strictEqual(r.rows[4].score, 1);
});

test('FAQ 命中率：命中/未命中分别统计', () => {
  const db = buildDb(TODAY);
  const r = runQuery({ metric: 'faq_hit_rate', days: 30 }, db);
  assert.strictEqual(r.total, 6);
  assert.strictEqual(r.extra.hit_rate, 66.7);
});

test('未解决工单：只含进行中与待人工，不受时间窗限制', () => {
  const db = buildDb(TODAY);
  const r = runQuery({ metric: 'unresolved', days: 1 }, db);
  assert.strictEqual(r.total, 2);
  assert.match(r.summary, /待人工 1/);
  assert.ok(r.rows.every((x) => x.status === 'active' || x.status === 'handoff'));
});

test('知识缺口：只统计 faq_miss=true 的提问', () => {
  const db = buildDb(TODAY);
  const r = runQuery({ metric: 'knowledge_gaps', days: 30 }, db);
  assert.strictEqual(r.total, 2);
  const qs = r.rows.map((x) => x.question).join('|');
  assert.match(qs, /开发票/);
  assert.match(qs, /老板/);
});

test('运营总览：单行汇总口径一致', () => {
  const db = buildDb(TODAY);
  const r = runQuery({ metric: 'overview', days: 14 }, db);
  const row = r.rows[0];
  assert.strictEqual(row.conversations, 5);
  assert.strictEqual(row.open, 2);
  assert.strictEqual(row.waiting, 1);
  assert.strictEqual(row.avg_score, 4);
  assert.strictEqual(row.faq_hit_rate, 60); // 14 天窗口内含 5 条带 faq_miss 标记的提问，命中 3 条
  assert.strictEqual(row.top_intent, '退款');
});

test('只读：执行前后数据快照完全一致', () => {
  const db = buildDb(TODAY);
  const before = JSON.stringify(db);
  for (const m of dslLib.METRIC_KEYS) {
    runQuery({ metric: m }, db);
  }
  assert.strictEqual(JSON.stringify(db), before, '执行器不得修改任何业务数据');
});

test('时间窗外不计入：30 天窗口包含 T-20，7 天窗口不包含', () => {
  const db = buildDb(TODAY);
  assert.strictEqual(runQuery({ metric: 'intent_share', days: 30 }, db).total, 6);
  assert.strictEqual(runQuery({ metric: 'intent_share', days: 7 }, db).total, 5);
});

/* ------------------------------ 限流与导出 ------------------------------ */

test('频率限制：同一操作者超过阈值即拒绝，窗口过后恢复', () => {
  let now = 1000;
  const limiter = createLimiter({ max: 3, windowMs: 60000, now: () => now });
  assert.strictEqual(limiter.hit('a').ok, true);
  assert.strictEqual(limiter.hit('a').ok, true);
  assert.strictEqual(limiter.hit('a').ok, true);
  const blocked = limiter.hit('a');
  assert.strictEqual(blocked.ok, false);
  assert.ok(blocked.retry_after >= 1);
  assert.strictEqual(limiter.hit('b').ok, true, '不同操作者互不影响');
  now += 61000;
  assert.strictEqual(limiter.hit('a').ok, true);
});

test('CSV 导出：BOM + 表头 + 数据行', () => {
  const db = buildDb(TODAY);
  const r = runQuery({ metric: 'rating_dist', days: 30 }, db);
  const csv = analytics.toCsv(r);
  assert.ok(csv.startsWith('\ufeff'));
  assert.match(csv, /星级/);
  assert.match(csv, /\r\n/);
  assert.strictEqual(csv.split('\r\n').length, 6); // 表头 + 5 档
});

test('meta：指标清单可被前端/文档消费', () => {
  const m = analytics.meta();
  assert.strictEqual(m.ok, true);
  assert.strictEqual(m.metrics.length, 8);
  assert.strictEqual(m.read_only, true);
  assert.deepStrictEqual(m.filters.status, ['active', 'handoff', 'closed']);
});
