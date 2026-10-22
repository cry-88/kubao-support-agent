/**
 * 数据分析 Agent · 统一入口
 *
 * 链路：频率限制 → 自然语言解析（规则为主）→ 模型兜底（预留位）→ DSL 白名单校验 → 只读执行
 * 三条硬约束：
 *   - 只读：执行器不写任何业务数据
 *   - 可控：没有通过白名单的 DSL 一律不执行；不拼接 SQL
 *   - 可解释：返回里带上"我是怎么理解这句话的"（signals + dsl + confidence）
 */
'use strict';

const dslLib = require('./dsl');
const parseLib = require('./parse');
const execute = require('./execute');
const { createLimiter } = require('./rate');
const config = require('../config');
const logger = require('../logger');

const APP_CONFIG = config.get();
const log = logger.create(APP_CONFIG.log.level, 'analytics');

const limiter = createLimiter({
  windowMs: 60000,
  max: APP_CONFIG.limits.analyticsPerMinute,
});

function todayKeyUtc8() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 支持的指标清单（供文档、测试与后续看板下拉使用） */
function meta() {
  return {
    ok: true,
    metrics: dslLib.METRIC_KEYS.map((k) => ({
      metric: k,
      label: dslLib.METRICS[k].label,
      desc: dslLib.METRICS[k].desc,
      default_days: dslLib.METRICS[k].defaultDays,
      dimensions: dslLib.METRICS[k].dimensions,
    })),
    filters: { status: dslLib.STATUS_KEYS, intent: dslLib.INTENT_KEYS, agent: '坐席姓名，按库内实际坐席匹配' },
    limits: { max_days: dslLib.MAX_DAYS, max_limit: dslLib.MAX_LIMIT, rate_per_minute: limiter.config.max },
    read_only: true,
  };
}

/** 把查询结果压成一段给人看的回答（对话式 BI / 命令行自测共用） */function formatAnswer(result, maxRows) {
  if (!result || result.ok === false) {
    const tips = (result && result.suggestions) || [];
    return (result && result.error ? result.error : '查询失败') +
      (tips.length ? '\n你可以这样问：\n' + tips.map((t) => '· ' + t).join('\n') : '');
  }
  const cap = maxRows || 8;
  const lines = [];
  lines.push('【' + result.metric_label + '】' + result.range.from + ' ~ ' + result.range.to);
  lines.push(result.summary);
  if (result.note) lines.push('（' + result.note + '）');
  const rows = result.rows.slice(0, cap);
  if (rows.length) {
    lines.push('明细（前 ' + rows.length + ' 行，共 ' + result.rows.length + ' 行）：');
    for (const r of rows) {
      lines.push('· ' + result.columns.map((c) => String(r[c.key] == null ? '-' : r[c.key])).join(' | '));
    }
  }
  return lines.join('\n');
}

/**
 * @param {object} opts
 * @param {string} [opts.text] 自然语言问句
 * @param {object} [opts.dsl] 结构化查询（优先于 text）
 * @param {object} opts.db 数据快照（store.db）
 * @param {string} opts.actor 限流与审计用的操作者标识
 * @param {string} [opts.today] UTC+8 的 YYYY-MM-DD
 * @param {Function} [opts.modelParse] 模型兜底：(text) => Promise<{metric,...}|null>
 * @returns {Promise<object>}
 */
async function query(opts) {
  const options = opts || {};
  const db = options.db;
  if (!db) return { ok: false, error: '数据源不可用' };

  const actor = String(options.actor || 'unknown');
  const limited = limiter.hit(actor);
  if (!limited.ok) {
    log.warn('触发分析查询限流', {
      event: 'rate_limit',
      scope: 'analytics',
      actor,
      limit_per_minute: limiter.config.max,
      retry_after_s: limited.retry_after,
      result: 'limited',
    });
    return {
      ok: false,
      error: '分析查询太频繁，请 ' + limited.retry_after + ' 秒后再试',
      code: 'rate_limited',
    };
  }

  const today = options.today || todayKeyUtc8();
  const startedAt = Date.now();
  let interpreted = null;
  let rawDsl = options.dsl || null;

  // 1) 自然语言 → DSL
  if (!rawDsl) {
    const text = String(options.text || '').trim();
    const parsed = parseLib.parse(text, { today, agents: db.agents });
    if (parsed.ok) {
      rawDsl = parsed.dsl;
      interpreted = { text, confidence: parsed.confidence, signals: parsed.signals, source: 'rules' };
    } else {
      // 2) 规则打不出置信度 → 模型兜底（当前环境未接模型时返回 null）
      let modelDsl = null;
      if (typeof options.modelParse === 'function') {
        try {
          modelDsl = await options.modelParse(text);
        } catch (e) {
          modelDsl = null;
        }
      }
      if (modelDsl && modelDsl.metric) {
        rawDsl = modelDsl;
        interpreted = { text, confidence: 0.5, signals: { source: 'model' }, source: 'model' };
      } else {
        logQuery(actor, text, 'unparsed', Date.now() - startedAt);
        return {
          ok: false,
          error: parsed.error,
          code: 'unparsed',
          suggestions: parsed.suggestions,
          supported: dslLib.METRIC_KEYS,
        };
      }
    }
  }

  // 3) 白名单校验（规则和模型产出的 DSL 一视同仁）
  const normalized = dslLib.normalize(rawDsl);
  if (!normalized.ok) {
    logQuery(actor, interpreted ? interpreted.text : JSON.stringify(rawDsl), 'invalid_dsl', Date.now() - startedAt);
    return { ok: false, error: normalized.error, code: 'invalid_dsl', detail: normalized.detail || null };
  }

  // 4) 只读执行
  const result = execute.run(normalized.dsl, db, today);
  logQuery(actor, interpreted ? interpreted.text : normalized.dsl.metric, result.ok ? 'ok' : 'failed', Date.now() - startedAt, result);

  if (!result.ok) return result;
  return Object.assign({}, result, {
    query: {
      text: interpreted ? interpreted.text : null,
      source: interpreted ? interpreted.source : 'dsl',
      confidence: interpreted ? interpreted.confidence : null,
      signals: interpreted ? interpreted.signals : null,
      dsl: normalized.dsl,
      elapsed_ms: Date.now() - startedAt,
    },
  });
}

/** 结构化审计日志：谁、问了什么、用了多久、命中哪个指标 */
function logQuery(actor, text, status, elapsed, result) {
  const fields = {
    event: 'analytics.query',
    actor: actor,
    status: status,
    duration_ms: elapsed,
    metric: (result && result.metric) || null,
    q: String(text == null ? '' : text).replace(/\s+/g, ' ').slice(0, 80),
  };
  if (status === 'ok') log.info('分析查询完成', fields);
  else log.warn('分析查询未完成', fields);
}

/** 导出 CSV 文本（BOM + CRLF，Excel 直接可开）；只走规则解析，不触发模型 */
function toCsv(result) {
  if (!result || result.ok === false) return null;
  const cell = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const head = result.columns.map((c) => cell(c.label)).join(',');
  const lines = [head];
  for (const r of result.rows) {
    lines.push(result.columns.map((c) => cell(r[c.key])).join(','));
  }
  return '\ufeff' + lines.join('\r\n');
}

function resetRateLimit(key) {
  limiter.reset(key);
}

/**
 * 看板聚合：一次请求返回四块数据（趋势 / 意图占比 / 坐席绩效 / 知识缺口）
 *
 * 为什么合一个接口：看板每次刷新要四份数据，拆成四次 RPC 会吃掉四份额度、
 * 也可能出现"趋势是这一秒、坐席是下一秒"的口径漂移。这里共用同一个数据快照与限流计数。
 */
function dashboard(opts) {
  const o = opts || {};
  const db = o.db;
  if (!db) return { ok: false, error: '数据源不可用' };

  const actor = String(o.actor || 'unknown');
  const limited = limiter.hit(actor);
  if (!limited.ok) {
    log.warn('触发看板查询限流', {
      event: 'rate_limit',
      scope: 'analytics',
      actor,
      retry_after_s: limited.retry_after,
      result: 'limited',
    });
    return { ok: false, error: '看板刷新太频繁，请 ' + limited.retry_after + ' 秒后再试', code: 'rate_limited' };
  }

  const days = Math.min(Math.max(Number(o.days) || 14, 1), dslLib.MAX_DAYS);
  const topN = Math.min(Math.max(Number(o.topN) || 5, 1), 20);
  const wide = Math.max(days, 30); // 坐席绩效与知识缺口用更宽的窗口，14 天常常样本不足
  const today = o.today || todayKeyUtc8();
  const elapsed = Date.now();

  const build = (raw) => {
    const n = dslLib.normalize(raw);
    if (!n.ok) return { ok: false, error: n.error };
    return execute.run(n.dsl, db, today);
  };

  const trend = build({ metric: 'ticket_trend', days });
  const intent = build({ metric: 'intent_share', days });
  const agents = build({ metric: 'agent_workload', days: wide });
  const gaps = build({ metric: 'knowledge_gaps', days: wide, limit: topN });

  const payload = {
    ok: true,
    days,
    trend_days: days,
    wide_days: wide,
    trend,
    intent,
    agents,
    gaps,
    generated_at: new Date().toISOString(),
    read_only: true,
  };

  log.info('看板数据已生成', {
    event: 'analytics.dashboard',
    actor,
    result: 'ok',
    duration_ms: Date.now() - elapsed,
    days,
    wide_days: wide,
    conversations: trend.total,
    agents: agents.rows.length,
    gaps: gaps.total,
  });

  return payload;
}

module.exports = { query, dashboard, meta, formatAnswer, toCsv, resetRateLimit, limiter, todayKeyUtc8 };
