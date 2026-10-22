/**
 * 配置层单元测试：三套环境、强制校验、CORS 判定、密钥不外泄
 * build() 是纯函数，测试直接喂 env 对象，不污染 process.env
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const config = require('../server/config');

const STRONG = 'Kubao#Prod-2026-x9';

test('开发环境默认值：debug 日志、放开本地 CORS、不缓存', () => {
  const c = config.build({ NODE_ENV: 'development' });
  assert.strictEqual(c.nodeEnv, 'development');
  assert.strictEqual(c.isDev, true);
  assert.strictEqual(c.log.level, 'debug');
  assert.strictEqual(c.static.cache, false);
  assert.strictEqual(c.limits.chatMessagesPerMinute, 12);
  assert.strictEqual(c.limits.analyticsPerMinute, 30);
  assert.ok(c.cors.origins.indexOf('http://localhost:8080') >= 0);
  assert.strictEqual(c.cors.allowAny, false);
});

test('测试环境默认值：warn 日志、无跨域、放宽聊天限流', () => {
  const c = config.build({ NODE_ENV: 'test' });
  assert.strictEqual(c.isTest, true);
  assert.strictEqual(c.log.level, 'warn');
  assert.deepStrictEqual(c.cors.origins, []);
  assert.strictEqual(c.limits.chatMessagesPerMinute, 60);
});

test('生产环境：合法配置通过，并开启缓存与 info 日志', () => {
  const c = config.build({ NODE_ENV: 'production', CS_ADMIN_CODE: STRONG });
  assert.strictEqual(c.isProd, true);
  assert.strictEqual(c.log.level, 'info');
  assert.strictEqual(c.static.cache, true);
  assert.strictEqual(c.security.usingDefaultAdminCode, false);
  assert.strictEqual(c.server.bodyLimitBytes, 1048576);
});

test('生产环境：没有口令拒绝启动', () => {
  assert.throws(() => config.build({ NODE_ENV: 'production' }), /CS_ADMIN_CODE/);
});

test('生产环境：沿用默认口令拒绝启动', () => {
  assert.throws(
    () => config.build({ NODE_ENV: 'production', CS_ADMIN_CODE: config.DEFAULT_ADMIN_CODE }),
    /CS_ADMIN_CODE/
  );
});

test('生产环境：CORS 通配符拒绝启动', () => {
  assert.throws(
    () => config.build({ NODE_ENV: 'production', CS_ADMIN_CODE: STRONG, CS_CORS_ORIGINS: '*' }),
    /CS_CORS_ORIGINS/
  );
});

test('生产环境：允许携带凭证时不能通配符', () => {
  assert.throws(
    () => config.build({ NODE_ENV: 'development', CS_CORS_ORIGINS: '*', CS_CORS_CREDENTIALS: 'true' }),
    /通配符/
  );
});

test('非法值：环境名 / 端口 / 日志等级 / 限流阈值', () => {
  assert.throws(() => config.build({ NODE_ENV: 'staging' }), /NODE_ENV/);
  assert.throws(() => config.build({ PORT: '0' }), /PORT/);
  assert.throws(() => config.build({ PORT: 'abc' }), /PORT/);
  assert.throws(() => config.build({ CS_LOG_LEVEL: 'verbose' }), /CS_LOG_LEVEL/);
  assert.throws(() => config.build({ CS_ANALYTICS_RATE: '0' }), /CS_ANALYTICS_RATE/);
});

test('静态目录 / 404 页不存在时拒绝启动', () => {
  assert.throws(() => config.build({ CS_STATIC_ROOT: 'no-such-dir-xyz' }), /CS_STATIC_ROOT/);
  assert.throws(() => config.build({ CS_NOT_FOUND_PAGE: 'no-such-page.html' }), /CS_NOT_FOUND_PAGE/);
});

test('环境变量覆盖默认值', () => {
  const c = config.build({
    NODE_ENV: 'development',
    PORT: '9090',
    CS_LOG_LEVEL: 'error',
    CS_CHAT_RATE: '5',
    CS_ANALYTICS_RATE: '7',
    CS_LOGIN_MAX_PER_CODE: '3',
    CS_CORS_ORIGINS: 'https://a.test, https://b.test ',
  });
  assert.strictEqual(c.server.port, 9090);
  assert.strictEqual(c.log.level, 'error');
  assert.strictEqual(c.limits.chatMessagesPerMinute, 5);
  assert.strictEqual(c.limits.analyticsPerMinute, 7);
  assert.strictEqual(c.limits.loginMaxPerCode, 3);
  assert.deepStrictEqual(c.cors.origins, ['https://a.test', 'https://b.test']);
});

test('CORS 判定：白名单精确匹配，未命中一律拒绝', () => {
  const c = config.build({ NODE_ENV: 'development', CS_CORS_ORIGINS: 'https://app.test' });
  assert.strictEqual(c.cors.allows('https://app.test'), true);
  assert.strictEqual(c.cors.allows('https://evil.test'), false);
  assert.strictEqual(c.cors.allows('https://app.test.evil.test'), false);
  assert.strictEqual(c.cors.allows(undefined), true, '无 Origin（同源/服务端调用）应放行');

  const any = config.build({ NODE_ENV: 'development', CS_CORS_ORIGINS: '*' });
  assert.strictEqual(any.cors.allowAny, true);
  assert.strictEqual(any.cors.allows('https://whatever.test'), true);
});

test('模型配置：只暴露是否已配置，不暴露密钥', () => {
  const local = config.build({ NODE_ENV: 'development' });
  assert.strictEqual(local.model.provider, 'local');
  assert.strictEqual(local.model.enabled, false);

  const remote = config.build({
    NODE_ENV: 'development',
    CS_MODEL_PROVIDER: 'openai-compatible',
    CS_MODEL_NAME: 'some-model',
    CS_MODEL_BASE_URL: 'https://llm.example.com',
    CS_MODEL_API_KEY: 'sk-should-never-leak',
  });
  assert.strictEqual(remote.model.enabled, true);
  assert.strictEqual(remote.model.apiKeySet, true);
  assert.doesNotMatch(JSON.stringify(remote), /sk-should-never-leak/);
});

test('runtimeConfig：可安全下发，不含口令与密钥', () => {
  const c = config.build({ NODE_ENV: 'production', CS_ADMIN_CODE: STRONG });
  const rc = config.runtimeConfig(c);
  assert.strictEqual(rc.ok, true);
  assert.strictEqual(rc.env, 'production');
  assert.strictEqual(rc.features.analytics, true);
  const s = JSON.stringify(rc);
  assert.doesNotMatch(s, new RegExp(STRONG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(s, /admin_code|api_key|ADMIN_CODE/i);
});

test('配置对象不可变（防止运行时被改写）', () => {
  const c = config.build({ NODE_ENV: 'development' });
  assert.throws(() => {
    'use strict';
    c.server.port = 1234;
  }, TypeError);
});

test('parseEnvText：跳过注释与空行，剥掉成对引号', () => {
  const parsed = config.parseEnvText(
    ['# 注释', '', 'A=1', 'B="hello world"', "C='x y'", 'D=', 'X==', 'X=2', 'no-equal-line'].join('\n')
  );
  assert.strictEqual(parsed.A, '1');
  assert.strictEqual(parsed.B, 'hello world');
  assert.strictEqual(parsed.C, 'x y');
  assert.strictEqual(parsed.D, '');
  assert.strictEqual(parsed.X, '2');
  assert.strictEqual(parsed['no-equal-line'], undefined);
});
