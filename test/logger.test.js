/**
 * 结构化日志与链路追踪单元测试
 * 通过替换 console 捕获输出，验证格式、等级、脱敏与 traceId 传递
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const logger = require('../server/logger');

const original = { log: console.log, warn: console.warn, error: console.error };
let captured = [];

function capture() {
  captured = [];
  console.log = (...a) => captured.push(a.join(' '));
  console.warn = (...a) => captured.push(a.join(' '));
  console.error = (...a) => captured.push(a.join(' '));
}

function restore() {
  console.log = original.log;
  console.warn = original.warn;
  console.error = original.error;
}

test.afterEach(() => {
  restore();
  logger.configure({ format: 'text', includeStack: true });
});

test('等级过滤：warn 实例不输出 info，输出 warn/error', () => {
  capture();
  const log = logger.create('warn', 'unit');
  log.info('不该出现');
  log.warn('应该出现');
  log.error('错误也出现');
  restore();
  assert.strictEqual(captured.length, 2);
  assert.ok(captured[0].includes('应该出现'));
  assert.ok(captured[1].includes('错误也出现'));
});

test('JSON 格式：一行一个对象，字段固定为 ts/level/module/msg', () => {
  logger.configure({ format: 'json' });
  capture();
  const log = logger.create('debug', 'rpc');
  log.info('调用完成', { event: 'rpc.call', fn: 'cs_guest_start', duration_ms: 3 });
  restore();

  assert.strictEqual(captured.length, 1);
  const obj = JSON.parse(captured[0]);
  assert.strictEqual(obj.level, 'info');
  assert.strictEqual(obj.module, 'rpc');
  assert.strictEqual(obj.msg, '调用完成');
  assert.strictEqual(obj.event, 'rpc.call');
  assert.strictEqual(obj.fn, 'cs_guest_start');
  assert.ok(obj.ts);
});

test('文本格式：包含等级、模块与 key=value', () => {
  logger.configure({ format: 'text' });
  capture();
  const log = logger.create('debug', 'http');
  log.info('请求完成', { status: 200, duration_ms: 5 });
  restore();

  assert.strictEqual(captured.length, 1);
  assert.match(captured[0], /INFO/);
  assert.match(captured[0], /\[http\]/);
  assert.match(captured[0], /status=200/);
});

test('链路追踪：同一上下文内所有日志自动带 trace_id', async () => {
  logger.configure({ format: 'json' });
  capture();
  await logger.withContext({ traceId: 'trace-abc-123' }, async () => {
    const log = logger.create('debug', 'svc');
    log.info('第一层');
    await new Promise((r) => setTimeout(r, 5));
    log.child('inner').info('第二层');
  });
  restore();

  assert.strictEqual(captured.length, 2);
  const a = JSON.parse(captured[0]);
  const b = JSON.parse(captured[1]);
  assert.strictEqual(a.trace_id, 'trace-abc-123');
  assert.strictEqual(b.trace_id, 'trace-abc-123');
  assert.strictEqual(b.module, 'svc:inner');
});

test('无上下文时不写 trace_id 字段', () => {
  logger.configure({ format: 'json' });
  capture();
  logger.create('debug', 'svc').info('无链路');
  restore();
  const obj = JSON.parse(captured[0]);
  assert.strictEqual(obj.trace_id, undefined);
});

test('脱敏：口令/密钥类字段统一打码', () => {
  logger.configure({ format: 'json' });
  capture();
  logger.create('debug', 'auth').info('登录', {
    code: 'super-secret',
    p_code: 'another',
    authCode: 'x',
    api_key: 'sk-1',
    token: 't',
    guest_key: 'guest-1234567890',
    operator_name: '客服A',
  });
  restore();

  const raw = captured[0];
  const obj = JSON.parse(raw);
  assert.strictEqual(obj.code, '[redacted]');
  assert.strictEqual(obj.p_code, '[redacted]');
  assert.strictEqual(obj.authCode, '[redacted]');
  assert.strictEqual(obj.api_key, '[redacted]');
  assert.strictEqual(obj.token, '[redacted]');
  assert.strictEqual(obj.guest_key, '[redacted]');
  assert.strictEqual(obj.operator_name, '客服A');
  assert.doesNotMatch(raw, /super-secret|another|guest-1234567890/);
});

test('错误序列化：默认带 name/message，关闭后不含堆栈', () => {
  logger.configure({ format: 'json', includeStack: false });
  capture();
  const err = new Error('磁盘满了');
  err.code = 'ENOSPC';
  logger.create('debug', 'store').error('写入失败', { event: 'store.save_failed', err });
  restore();

  const obj = JSON.parse(captured[0]);
  assert.strictEqual(obj.err.name, 'Error');
  assert.strictEqual(obj.err.message, '磁盘满了');
  assert.strictEqual(obj.err.code, 'ENOSPC');
  assert.strictEqual(obj.err.stack, undefined);
});

test('超长字符串截断，避免日志被单条撑爆', () => {
  logger.configure({ format: 'json' });
  capture();
  logger.create('debug', 'x').info('长文本', { content: 'a'.repeat(2000) });
  restore();
  const obj = JSON.parse(captured[0]);
  assert.ok(obj.content.length < 500);
  assert.ok(obj.content.endsWith('…'));
});

test('must()：低等级实例也能输出启动信息', () => {
  capture();
  logger.create('error', 'boot').must('启动完成');
  restore();
  assert.strictEqual(captured.length, 1);
  assert.ok(captured[0].includes('启动完成'));
});

test('timer()：返回非负毫秒数', async () => {
  const elapsed = logger.timer();
  await new Promise((r) => setTimeout(r, 12));
  const ms = elapsed();
  assert.ok(ms >= 0);
  assert.ok(ms < 1000);
});

test('newTraceId()：唯一且长度可控', () => {
  const ids = new Set();
  for (let i = 0; i < 100; i += 1) {
    const id = logger.newTraceId();
    assert.match(id, /^[a-z0-9]{8,32}$/);
    ids.add(id);
  }
  assert.strictEqual(ids.size, 100);
});

test('配置可读回，非法值被忽略', () => {
  logger.configure({ format: 'json', includeStack: false });
  const s = logger.getSettings();
  assert.strictEqual(s.format, 'json');
  assert.strictEqual(s.includeStack, false);

  logger.configure({ format: 'xml' });
  assert.strictEqual(logger.getSettings().format, 'json', '非法格式不生效');
});
