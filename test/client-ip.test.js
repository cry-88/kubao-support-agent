/**
 * 可信代理与真实 IP 解析单元测试（阶段6）
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const clientIp = require('../server/client-ip');

const LOOPBACKS = ['127.0.0.1', '::1'];

test('默认不信任代理头：直接用 socket 地址', () => {
  const r = clientIp.resolve({ peer: '127.0.0.1', xff: '203.0.113.9', trust: false, trusted: LOOPBACKS });
  assert.strictEqual(r.ip, '127.0.0.1');
  assert.strictEqual(r.source, 'socket');
  assert.strictEqual(r.trusted, false);
});

test('开启可信代理且对端是代理：采信 XFF 最后一段', () => {
  const r = clientIp.resolve({
    peer: '::ffff:127.0.0.1',
    xff: '203.0.113.9, 198.51.100.7',
    trust: true,
    trusted: LOOPBACKS,
  });
  assert.strictEqual(r.ip, '198.51.100.7');
  assert.strictEqual(r.source, 'x-forwarded-for');
  assert.strictEqual(r.trusted, true);
  assert.strictEqual(r.chain, 2);
});

test('防伪造：客户端自己塞的 XFF 前缀不会被采信', () => {
  // 客户端伪造 1.2.3.4，Nginx 追加真实来源 203.0.113.9
  const r = clientIp.resolve({
    peer: '127.0.0.1',
    xff: '1.2.3.4, 203.0.113.9',
    trust: true,
    trusted: LOOPBACKS,
  });
  assert.strictEqual(r.ip, '203.0.113.9');
});

test('对端不是可信代理：即使带头也忽略', () => {
  const r = clientIp.resolve({
    peer: '10.0.0.5',
    xff: '203.0.113.9',
    trust: true,
    trusted: LOOPBACKS,
  });
  assert.strictEqual(r.ip, '10.0.0.5');
  assert.strictEqual(r.source, 'socket');
});

test('自定义可信代理列表生效', () => {
  const trusted = ['10.0.0.5'];
  const ok = clientIp.resolve({ peer: '10.0.0.5', xff: '203.0.113.9', trust: true, trusted });
  assert.strictEqual(ok.ip, '203.0.113.9');
  const no = clientIp.resolve({ peer: '127.0.0.1', xff: '203.0.113.9', trust: true, trusted });
  assert.strictEqual(no.ip, '127.0.0.1', '不在列表里的对端不可信');
});

test('非法 XFF 回退到 socket 地址并标记 invalid', () => {
  const r = clientIp.resolve({ peer: '127.0.0.1', xff: 'not-an-ip', trust: true, trusted: LOOPBACKS });
  assert.strictEqual(r.ip, '127.0.0.1');
  assert.strictEqual(r.invalid, true);
});

test('XFF 为空段落被忽略，取最后一个合法值', () => {
  const r = clientIp.resolve({ peer: '127.0.0.1', xff: '203.0.113.9, ', trust: true, trusted: LOOPBACKS });
  assert.strictEqual(r.ip, '203.0.113.9');
});

test('IPv6 环回与 ::ffff: 前缀归一化', () => {
  assert.strictEqual(clientIp.normalize('::1'), '127.0.0.1');
  assert.strictEqual(clientIp.normalize('::ffff:10.1.2.3'), '10.1.2.3');
  assert.strictEqual(clientIp.normalize(' 203.0.113.9 '), '203.0.113.9');
  assert.strictEqual(clientIp.isLoopback('127.0.0.1'), true);
  assert.strictEqual(clientIp.isLoopback('127.5.5.5'), true);
  assert.strictEqual(clientIp.isLoopback('203.0.113.9'), false);
});

test('没有 peer 时不抛错', () => {
  const r = clientIp.resolve({ peer: '', xff: '', trust: true, trusted: LOOPBACKS });
  assert.strictEqual(r.ip, '-');
});
