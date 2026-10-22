/**
 * /api/chat 任务分流单元测试：新显式 task 与旧"猜提示词"必须结果一致
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const reply = require('../server/reply');

const ORDER_SYSTEM = [
  '本轮系统判定的用户意图：查询订单（order）。',
  '可参考的 FAQ 知识库条目（优先采用；若与用户问题无关则忽略，绝不编造未提供的事实）：',
  '[1] 问题：怎么查询订单状态？',
  '    回答：进入「我的订单」即可看到全部订单及其状态。',
  '系统实时查询到的订单信息（可直接引用，不要改写数字）：',
  '- 订单号：A2024001',
  '- 商品：轻氧空气净化器 Pro',
  '- 金额：¥1299.00',
  '- 状态：已签收',
  '- 快递：顺丰速运 SF1234567890123',
  '- 预计送达：2026-10-20',
  '回复要求：1. 简洁。',
].join('\n');

test('兼容：respond(messages) 旧调用仍然可用', () => {
  const out = reply.respond([
    { role: 'system', content: ORDER_SYSTEM },
    { role: 'user', content: '我的订单 A2024001 到哪了？' },
  ]);
  assert.strictEqual(out.task, 'answer');
  assert.match(out.text, /已签收/);
  assert.match(out.text, /SF1234567890123/);
});

test('answer：显式 task 与旧调用产出同一段回答', () => {
  const messages = [
    { role: 'system', content: ORDER_SYSTEM },
    { role: 'user', content: '我的订单 A2024001 到哪了？' },
  ];
  const legacy = reply.respond(messages).text;
  const explicit = reply.respond({ task: 'answer', messages }).text;
  assert.strictEqual(explicit, legacy);
});

test('classify：显式 task 与旧"意图分类器"提示词一致', () => {
  const messages = [
    { role: 'system', content: '你是精确的意图分类器，只输出 JSON，不要输出任何其它内容。' },
    { role: 'user', content: '用户消息：App 一打开就闪退' },
  ];
  const legacy = JSON.parse(reply.respond(messages).text);
  const explicit = JSON.parse(reply.respond({ task: 'classify', messages }).text);
  assert.deepStrictEqual(explicit, legacy);
  assert.strictEqual(explicit.intent, 'tech');
});

test('summary：显式 task 与旧"会话摘要助手"提示词一致', () => {
  const transcript = '用户：订单 A2024001 到哪了\n客服：已签收。\n用户：能退款吗\n客服：未拆封可全额退。';
  const messages = [
    { role: 'system', content: '你是会话摘要助手。把客服对话压缩成不超过 200 字的中文摘要。' },
    { role: 'user', content: transcript },
  ];
  const legacy = reply.respond(messages).text;
  const explicit = reply.respond({ task: 'summary', messages }).text;
  assert.strictEqual(explicit, legacy);
  assert.match(explicit, /A2024001/);
});

test('未知 task 值：退回自动识别，不报错、不猜任务', () => {
  const messages = [
    { role: 'system', content: ORDER_SYSTEM },
    { role: 'user', content: '我的订单 A2024001 到哪了？' },
  ];
  const out = reply.respond({ task: 'drop_everything', messages });
  assert.strictEqual(out.task, 'answer');
  assert.match(out.text, /已签收/);
});

test('analytics_parse：未接模型时返回 metric=null，绝不猜指标', async () => {
  const out = reply.respond({ task: 'analytics_parse', messages: [{ role: 'user', content: '上周表现怎么样' }] });
  const parsed = JSON.parse(out.text);
  assert.strictEqual(parsed.metric, null);
  assert.strictEqual(parsed.reason, 'model_not_configured');
  const fallback = await reply.parseAnalyticsFallback('上周表现怎么样');
  assert.strictEqual(fallback, null);
});

test('不编造：没有订单块时不会凭空给出快递单号', () => {
  const out = reply.respond([
    { role: 'system', content: '本轮系统判定的用户意图：查询订单（order）。\n可参考的 FAQ 知识库条目（优先采用；若与用户问题无关则忽略，绝不编造未提供的事实）：\n（本轮未检索到匹配的 FAQ 条目）\n系统查询结果：用户提供的订单号在系统中未找到，请提示用户核对订单号，不要编造订单信息。' },
    { role: 'user', content: '订单 Z9999999 到哪了' },
  ]).text;
  assert.doesNotMatch(out, /SF\d|顺丰|中通/);
  assert.match(out, /没有查到/);
});
