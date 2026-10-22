/**
 * 数据分析 · 查询 DSL 与白名单校验
 *
 * 设计原则（对应阶段2 约束）：
 *   1. 只读：DSL 里没有任何写操作，执行层只遍历快照、不改数据
 *   2. 白名单：指标、维度、过滤字段、排序、条数全部枚举化；不认的键直接拒绝
 *   3. 不拼 SQL：DSL 是结构化对象，执行层按指标分派函数，不存在字符串拼接执行
 *   4. 兜底边界：时间窗 1~90 天、返回行数 ≤200，避免一次查询把整库拖出来
 */
'use strict';

const INTENT_LABELS = {
  refund: '退款',
  order: '查询订单',
  tech: '技术支持',
  other: '其他',
  unknown: '未识别',
};

const STATUS_LABELS = {
  active: '进行中',
  handoff: '待人工',
  closed: '已结束',
};

const STATUS_KEYS = Object.keys(STATUS_LABELS);
const INTENT_KEYS = Object.keys(INTENT_LABELS).filter((k) => k !== 'unknown');

/** 指标白名单：新增指标必须在这里登记，执行层也要有对应函数 */
const METRICS = {
  ticket_trend: {
    label: '工单量趋势',
    desc: '按天统计新建工单数、转人工数、已解决数与当日平均满意度',
    defaultDays: 14,
    dimensions: ['day'],
  },
  intent_share: {
    label: '意图标签占比',
    desc: '各意图（退款 / 查询订单 / 技术支持 / 其他）的工单量与占比',
    defaultDays: 30,
    dimensions: ['intent'],
  },
  agent_workload: {
    label: '坐席工作量',
    desc: '每个坐席的接单量、解决量、平均首次响应时长与好评率',
    defaultDays: 30,
    dimensions: ['agent'],
  },
  rating_dist: {
    label: '评价分布',
    desc: '1~5 星评价的数量与占比，含平均分与好评率',
    defaultDays: 30,
    dimensions: ['score'],
  },
  faq_hit_rate: {
    label: 'FAQ 命中率',
    desc: '用户提问中命中知识库的比例，按天给出命中/未命中数',
    defaultDays: 14,
    dimensions: ['day'],
  },
  unresolved: {
    label: '未解决工单',
    desc: '当前仍处于进行中或待人工的工单明细',
    defaultDays: 30,
    dimensions: ['conversation'],
  },
  knowledge_gaps: {
    label: '高频知识缺口',
    desc: 'FAQ 未命中的用户提问，按出现次数排序',
    defaultDays: 30,
    dimensions: ['question'],
  },
  overview: {
    label: '运营总览',
    desc: '工单量、未解决、平均满意度、FAQ 命中率、Top 意图的单行汇总',
    defaultDays: 14,
    dimensions: [],
  },
};

const METRIC_KEYS = Object.keys(METRICS);
const MAX_DAYS = 90;
const MAX_LIMIT = 200;

function isDateStr(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(new Date(v + 'T00:00:00Z').getTime());
}

function fail(error, detail) {
  return { ok: false, error, detail: detail || null };
}

/**
 * 校验并归一化 DSL。任何未登记的键都会被忽略（保持宽松读入、严格执行）
 * @param {object} raw
 * @returns {{ok:true, dsl:object} | {ok:false, error:string, detail?:any}}
 */
function normalize(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('查询描述必须是一个对象');
  }

  const metric = String(raw.metric || '').trim();
  if (!metric) return fail('缺少 metric（要统计的指标）');
  if (!METRICS[metric]) {
    return fail('不支持的指标：' + metric, { supported: METRIC_KEYS });
  }
  const def = METRICS[metric];

  let days = raw.days == null ? def.defaultDays : Number(raw.days);
  if (!Number.isFinite(days)) return fail('days 必须是数字');
  days = Math.floor(days);

  let from = null;
  let to = null;
  if (raw.from != null || raw.to != null) {
    if (!isDateStr(raw.from) || !isDateStr(raw.to)) return fail('from / to 必须是 YYYY-MM-DD');
    if (raw.from > raw.to) return fail('起始日期不能晚于结束日期');
    from = raw.from;
    to = raw.to;
    days = Math.floor((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000) + 1;
  }

  if (days < 1 || days > MAX_DAYS) return fail('时间范围需在 1~' + MAX_DAYS + ' 天之间');

  let limit = raw.limit == null ? 20 : Number(raw.limit);
  if (!Number.isFinite(limit)) return fail('limit 必须是数字');
  limit = Math.floor(limit);
  if (limit < 1 || limit > MAX_LIMIT) return fail('条数需在 1~' + MAX_LIMIT + ' 之间');

  const dimension = def.dimensions.length
    ? (def.dimensions.indexOf(raw.dimension) >= 0 ? raw.dimension : def.dimensions[0])
    : null;

  const rawFilters = raw.filters && typeof raw.filters === 'object' ? raw.filters : {};
  const filters = {};
  if (rawFilters.status != null) {
    if (STATUS_KEYS.indexOf(rawFilters.status) < 0) {
      return fail('不支持的状态过滤：' + rawFilters.status, { supported: STATUS_KEYS });
    }
    filters.status = rawFilters.status;
  }
  if (rawFilters.intent != null) {
    if (INTENT_KEYS.indexOf(rawFilters.intent) < 0) {
      return fail('不支持的意图过滤：' + rawFilters.intent, { supported: INTENT_KEYS });
    }
    filters.intent = rawFilters.intent;
  }
  if (rawFilters.agent != null) {
    const agent = String(rawFilters.agent).trim();
    if (agent.length > 40) return fail('坐席名过长');
    if (agent) filters.agent = agent;
  }

  const order = raw.order === 'asc' ? 'asc' : 'desc';

  return {
    ok: true,
    dsl: { metric, dimension, days, from, to, limit, order, filters },
  };
}

/** 把 DSL 的时间窗换算成 UTC+8 的日期键区间 */
function range(dsl, todayKey) {
  const today = todayKey;
  if (dsl.from && dsl.to) return { from: dsl.from, to: dsl.to, days: dsl.days };
  const end = new Date(today + 'T00:00:00Z');
  const start = new Date(end.getTime() - (dsl.days - 1) * 86400000);
  return { from: start.toISOString().slice(0, 10), to: today, days: dsl.days };
}

module.exports = {
  METRICS,
  METRIC_KEYS,
  INTENT_LABELS,
  STATUS_LABELS,
  INTENT_KEYS,
  STATUS_KEYS,
  MAX_DAYS,
  MAX_LIMIT,
  normalize,
  range,
  isDateStr,
};
