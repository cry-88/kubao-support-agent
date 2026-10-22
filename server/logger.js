/**
 * 结构化日志 + 链路追踪（阶段4）
 *
 * 对外接口保持阶段3 的形状（create(level, tag) → debug/info/warn/error/child/enabled），
 * 所以各业务模块的调用点不用改；内部换成：
 *
 *   - 结构化输出：生产默认 JSON 行（一行一事件，便于 journald / 日志采集），开发默认可读文本
 *   - 链路追踪：AsyncLocalStorage 存 traceId，一个请求内所有日志自动带上，不需要层层传参
 *   - 敏感字段脱敏：code / password / token / api_key 之类的键统一打码
 *   - 错误对象序列化：只保留 name/message/code，堆栈按环境决定是否输出
 *
 * 约定的事件字段（便于检索）：
 *   event        事件名，如 http.request / rpc.call / auth.login / ticket.claim / rate_limit / model.call
 *   trace_id     链路 id
 *   result       ok | fail | reject | conflict | limited
 *   duration_ms  耗时
 */
'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const crypto = require('crypto');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const REDACT_KEYS = /^(code|p_code|authcode|auth_code|password|passwd|token|authorization|api_?key|secret|guest_key)$/i;
const MAX_STR = 400;

const als = new AsyncLocalStorage();

const settings = {
  format: 'text', // text | json
  includeStack: true,
  service: 'kubao-support',
};

function configure(opts) {
  const o = opts || {};
  if (o.format === 'json' || o.format === 'text') settings.format = o.format;
  if (typeof o.includeStack === 'boolean') settings.includeStack = o.includeStack;
  if (o.service) settings.service = o.service;
  return Object.assign({}, settings);
}

function getSettings() {
  return Object.assign({}, settings);
}

/** 生成 / 读取链路 id */
function newTraceId() {
  try {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  } catch (e) {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
}

function withContext(ctx, fn) {
  return als.run(Object.assign({}, ctx), fn);
}

function currentContext() {
  return als.getStore() || {};
}

function serializeError(e) {
  if (!e) return null;
  if (!(e instanceof Error)) return sanitizeValue(e);
  const info = { name: e.name, message: e.message };
  if (e.code) info.code = e.code;
  if (settings.includeStack && e.stack) info.stack = String(e.stack).split('\n').slice(0, 8).join('\n');
  return info;
}

function sanitizeValue(v) {
  if (v == null) return v;
  if (typeof v === 'string') return v.length > MAX_STR ? v.slice(0, MAX_STR) + '…' : v;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (v instanceof Error) return serializeError(v);
  if (Array.isArray(v)) return v.slice(0, 20).map(sanitizeValue);
  if (typeof v === 'object') {
    const out = {};
    let count = 0;
    for (const k of Object.keys(v)) {
      if (count >= 20) break;
      out[k] = REDACT_KEYS.test(k) ? '[redacted]' : sanitizeValue(v[k]);
      count += 1;
    }
    return out;
  }
  return String(v);
}

function formatLine(level, module, msg, fields) {
  const ts = new Date().toISOString();
  const trace = currentContext().traceId || null;
  const data = {};

  for (const k of Object.keys(fields || {})) {
    data[k] = REDACT_KEYS.test(k) ? '[redacted]' : sanitizeValue(fields[k]);
  }

  if (settings.format === 'json') {
    const obj = { ts, level, module: module || null, msg: String(msg) };
    if (trace) obj.trace_id = trace;
    Object.assign(obj, data);
    return JSON.stringify(obj);
  }

  const lv = level.toUpperCase().padEnd(5, ' ');
  const parts = [ts, lv, module ? '[' + module + ']' : '', String(msg)];
  for (const k of Object.keys(data)) {
    const v = data[k];
    parts.push(k + '=' + (typeof v === 'object' ? JSON.stringify(v) : v));
  }
  if (trace) parts.push('trace=' + trace);
  return parts.filter(Boolean).join(' ');
}

function write(level, module, msg, fields) {
  const line = formatLine(level, module, msg, fields);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/**
 * 创建 logger 实例
 * @param {string} level 最低等级：debug | info | warn | error
 * @param {string} [tag] 模块名，出现在每条日志里
 * @param {object} [base] 该实例固定的字段（如 component: 'rpc'）
 */
function create(level, tag, base) {
  const min = LEVELS[level] || LEVELS.info;
  const module = tag || null;
  const baseFields = base || {};

  function emit(name, args) {
    if (LEVELS[name] < min) return;
    let msg = '';
    const fields = Object.assign({}, baseFields);
    if (args.length === 0) {
      msg = '';
    } else if (typeof args[0] === 'string') {
      msg = args[0];
      if (args[1] && typeof args[1] === 'object') Object.assign(fields, args[1]);
    } else if (args[0] instanceof Error) {
      msg = args[0].message;
      fields.err = args[0];
      if (args[1] && typeof args[1] === 'object') Object.assign(fields, args[1]);
    } else {
      msg = String(args[0]);
    }
    write(name, module, msg, fields);
  }

  return {
    level,
    tag: module,
    debug: function () { emit('debug', Array.prototype.slice.call(arguments)); },
    info: function () { emit('info', Array.prototype.slice.call(arguments)); },
    warn: function () { emit('warn', Array.prototype.slice.call(arguments)); },
    error: function () { emit('error', Array.prototype.slice.call(arguments)); },
    /** 不受等级限制，用于启动横幅 */
    must: function () {
      const args = Array.prototype.slice.call(arguments);
      const msg = typeof args[0] === 'string' ? args[0] : String(args[0]);
      write('info', module, msg, args[1] && typeof args[1] === 'object' ? args[1] : {});
    },
    child: function (t, extra) {
      const name = module ? module + ':' + t : t;
      return create(level, name, Object.assign({}, baseFields, extra || {}));
    },
    enabled: function (name) {
      return LEVELS[name] >= min;
    },
  };
}

/** 计时器：返回一个读取毫秒数的函数（保留 1 位小数） */
function timer() {
  const start = process.hrtime.bigint();
  return function elapsed() {
    return Math.round(Number(process.hrtime.bigint() - start) / 1e5) / 10;
  };
}

module.exports = {
  LEVELS,
  create,
  configure,
  getSettings,
  newTraceId,
  withContext,
  currentContext,
  timer,
  serializeError,
};
