/**
 * 阶段5 · 看板聚合接口单元测试
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const analytics = require('../server/analytics');
const { buildDb } = require('./fixtures');

const TODAY = '2026-10-22';

test('看板聚合：一次返回四块数据，口径与单指标查询一致', () => {
  const db = buildDb(TODAY);
  const r = analytics.dashboard({ db, days: 7, topN: 5, today: TODAY, actor: 'unit:1' });

  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.days, 7);
  assert.strictEqual(r.trend_days, 7);
  assert.strictEqual(r.wide_days, 30);
  assert.strictEqual(r.read_only, true);
  assert.ok(r.generated_at);

  assert.strictEqual(r.trend.metric, 'ticket_trend');
  assert.strictEqual(r.trend.rows.length, 7);
  assert.strictEqual(r.trend.total, 5);

  assert.strictEqual(r.intent.metric, 'intent_share');
  assert.strictEqual(r.intent.total, 5);

  assert.strictEqual(r.agents.metric, 'agent_workload');
  assert.ok(r.agents.rows.length >= 2);
  const a = r.agents.rows.find((x) => x.agent === '客服A');
  assert.strictEqual(a.claimed, 2);
  assert.strictEqual(a.avg_first_response, 3600);
  assert.strictEqual(a.good_rate, 50);

  assert.strictEqual(r.gaps.metric, 'knowledge_gaps');
  assert.strictEqual(r.gaps.total, 2);
  assert.ok(r.gaps.rows.length <= 5);
});

test('看板聚合：默认窗口 14 天，坐席与缺口用 30 天', () => {
  const db = buildDb(TODAY);
  const r = analytics.dashboard({ db, today: TODAY, actor: 'unit:2' });
  assert.strictEqual(r.days, 14);
  assert.strictEqual(r.trend.rows.length, 14);
  assert.strictEqual(r.wide_days, 30);
  assert.strictEqual(r.gaps.total, 2, 'T-20 的缺口提问应落在 30 天窗口内');
});

test('看板聚合：天数与条数被限制在安全范围内', () => {
  const db = buildDb(TODAY);
  const tooBig = analytics.dashboard({ db, days: 999, topN: 999, today: TODAY, actor: 'unit:3' });
  assert.strictEqual(tooBig.days, 90);
  assert.ok(tooBig.gaps.rows.length <= 20);

  const tooSmall = analytics.dashboard({ db, days: 0, topN: 0, today: TODAY, actor: 'unit:4' });
  assert.strictEqual(tooSmall.days, 14, '0 视为未传，落回默认值');
});

test('看板聚合：只读，不修改业务数据', () => {
  const db = buildDb(TODAY);
  const before = JSON.stringify(db);
  analytics.dashboard({ db, days: 14, today: TODAY, actor: 'unit:5' });
  assert.strictEqual(JSON.stringify(db), before);
});

test('看板聚合：同样受频率限制约束', () => {
  const db = buildDb(TODAY);
  const actor = 'unit:rate-' + Date.now();
  let blocked = null;
  for (let i = 0; i < 200; i += 1) {
    const r = analytics.dashboard({ db, today: TODAY, actor });
    if (r.ok === false) {
      blocked = r;
      break;
    }
  }
  assert.ok(blocked, '持续刷新应触发限流');
  assert.strictEqual(blocked.code, 'rate_limited');
  assert.match(blocked.error, /太频繁/);
  analytics.resetRateLimit(actor);
});
