/**
 * 数据分析 · 自然语言 → 结构化查询（规则解析为主）
 *
 * 为什么不用模型做第一步：分析问句的词汇高度收敛（"趋势 / 占比 / 坐席 / 评价 / 命中率 / 未解决"），
 * 规则命中率足够高、延迟低、可解释、可测试，而且离线环境也能跑。
 * 规则打不出置信度时，才走 reply.js 的 analytics_parse 兜底（预留模型位，不新建通道）。
 */
'use strict';

const { METRICS } = require('./dsl');

/** 指标关键词字典：命中即加权，取得分最高者 */
const METRIC_RULES = [
  {
    metric: 'knowledge_gaps',
    words: [
      ['知识缺口', 6], ['没答上', 4], ['答不上', 4], ['未命中', 3], ['没命中', 3],
      ['没有命中', 3], ['缺口', 3], ['知识库没有', 5], ['没回答', 3],
    ],
  },
  {
    metric: 'faq_hit_rate',
    words: [['faq命中', 6], ['命中率', 5], ['知识库命中', 5], ['命中', 2], ['faq', 2]],
  },
  {
    metric: 'agent_workload',
    words: [
      ['客服绩效', 6], ['坐席绩效', 6], ['工作量', 5], ['坐席', 4], ['接单', 4],
      ['响应时长', 4], ['绩效', 4], ['谁处理', 3], ['人均', 2], ['每个人', 2],
    ],
  },
  {
    metric: 'rating_dist',
    words: [
      ['评价', 4], ['满意度', 5], ['星级', 4], ['评分', 4], ['好评率', 4], ['差评', 3], ['五星', 3],
    ],
  },
  {
    metric: 'unresolved',
    words: [
      ['未解决', 6], ['待处理', 4], ['积压', 4], ['没人接', 4], ['待接入', 4], ['排队', 3], ['没解决', 5],
    ],
  },
  {
    metric: 'intent_share',
    words: [['意图', 5], ['占比', 3], ['分布', 2], ['分类统计', 3], ['哪类', 3]],
  },
  {
    metric: 'ticket_trend',
    words: [
      ['趋势', 5], ['走势', 4], ['每天', 3], ['每日', 3], ['工单量', 4],
      ['会话量', 4], ['咨询量', 4], ['新增', 2], ['曲线', 3], ['工单', 3], ['会话', 2],
    ],
  },
  {
    metric: 'overview',
    words: [['总览', 6], ['概况', 5], ['整体情况', 5], ['大盘', 4], ['汇总一下', 4]],
  },
];

const CN_NUM = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function addDays(key, n) {
  return new Date(Date.parse(key + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
}

function monthStart(key) {
  return key.slice(0, 8) + '01';
}

/** 极简中文数字 → 整数（够覆盖 1~99 的常见写法） */
function cnToNum(s) {
  if (/^\d+$/.test(s)) return Number(s);
  if (s.length === 1 && CN_NUM[s]) return CN_NUM[s];
  const m = s.match(/^十([一二三四五六七八九])?$/);
  if (m) return 10 + (m[1] ? CN_NUM[m[1]] : 0);
  const m2 = s.match(/^([一二三四五六七八九])十([一二三四五六七八九])?$/);
  if (m2) return CN_NUM[m2[1]] * 10 + (m2[2] ? CN_NUM[m2[2]] : 0);
  return null;
}

function detectTime(text, today) {
  // 显式区间：2026-10-01 到 2026-10-22
  let m = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})\s*(?:到|至|~|～|-)\s*(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) {
    const pad = (x) => String(x).padStart(2, '0');
    return { from: m[1] + '-' + pad(m[2]) + '-' + pad(m[3]), to: m[4] + '-' + pad(m[5]) + '-' + pad(m[6]), by: m[0] };
  }
  // 显式区间：10月1日到10月22日（默认当年）
  m = text.match(/(\d{1,2})月(\d{1,2})日?\s*(?:到|至|~|～|-)\s*(\d{1,2})月(\d{1,2})日?/);
  if (m) {
    const y = today.slice(0, 4);
    const pad = (x) => String(x).padStart(2, '0');
    return { from: y + '-' + pad(m[1]) + '-' + pad(m[2]), to: y + '-' + pad(m[3]) + '-' + pad(m[4]), by: m[0] };
  }
  // 近 N 天 / 最近 N 天 / 过去 N 天 / N 天
  m = text.match(/(?:近|最近|过去|前)\s*([0-9一二两三四五六七八九十]+)\s*(?:天|日)/);
  if (!m) m = text.match(/([0-9一二两三四五六七八九十]+)\s*(?:天|日)(?:内|里|以内)?/);
  if (m) {
    const n = cnToNum(m[1]);
    if (n && n > 0) return { days: n, by: m[0] };
  }
  if (/昨天|昨日/.test(text)) return { from: addDays(today, -1), to: addDays(today, -1), by: '昨天' };
  if (/今天|今日|当天/.test(text)) return { from: today, to: today, by: '今天' };
  if (/本周|这周|这一周|近一周|最近一周|近7天|过去一周/.test(text)) return { days: 7, by: '近一周' };
  if (/本月|这个月|当月/.test(text)) return { from: monthStart(today), to: today, by: '本月' };
  if (/上个月|上月/.test(text)) {
    const thisMonth = monthStart(today);
    const lastEnd = addDays(thisMonth, -1);
    return { from: monthStart(lastEnd), to: lastEnd, by: '上个月' };
  }
  if (/近一个月|最近一个月|一个月|30天/.test(text)) return { days: 30, by: '近一个月' };
  if (/近三个月|最近三个月|季度/.test(text)) return { days: 90, by: '近三个月' };
  return null;
}

function detectFilters(text, agents) {
  const filters = {};
  // 状态
  if (/待接入|待人工|等人工|排队中|没人接/.test(text)) filters.status = 'handoff';
  else if (/已结束|已解决|关闭|已完成|结案/.test(text)) filters.status = 'closed';
  else if (/进行中|处理中|活跃/.test(text)) filters.status = 'active';

  // 意图
  if (/退款|退货|售后|退钱/.test(text)) filters.intent = 'refund';
  else if (/订单|物流|快递|发货|运单/.test(text)) filters.intent = 'order';
  else if (/技术|故障|闪退|白屏|登录|支付失败|报错/.test(text)) filters.intent = 'tech';
  else if (/其他意图|其它意图/.test(text)) filters.intent = 'other';

  // 坐席（按库里真实坐席名匹配，避免写死）
  const list = Array.isArray(agents) ? agents : [];
  for (const a of list) {
    if (a && a.name && text.indexOf(a.name) >= 0) {
      filters.agent = a.name;
      break;
    }
  }
  if (!filters.agent && /管理员/.test(text)) filters.agent = '管理员';

  return filters;
}

function detectLimit(text) {
  const m = text.match(/(?:前|top|Top|最多|取)\s*(\d{1,3})\s*(?:条|个|名|位)?/);
  if (m) return Number(m[1]);
  return null;
}

/**
 * 打分：同一指标的多关键词累加；FAQ 命中率要排除"未命中/没命中"以免和知识缺口抢
 */
function scoreMetrics(text) {
  const hits = [];
  for (const rule of METRIC_RULES) {
    let score = 0;
    let best = null;
    for (const [word, weight] of rule.words) {
      let count = 0;
      if (word === '命中') {
        count = (text.match(/命中/g) || []).length - (text.match(/(?:未|没|不)命中/g) || []).length;
      } else {
        count = text.toLowerCase().split(word.toLowerCase()).length - 1;
      }
      if (count > 0) {
        score += weight * Math.min(count, 2);
        if (!best || weight > best.weight) best = { word, weight };
      }
    }
    if (score > 0) hits.push({ metric: rule.metric, score, word: best ? best.word : '' });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits;
}

/**
 * @param {string} text 自然语言问句
 * @param {{today:string, agents?:Array<{name:string}>}} opts today 为 UTC+8 的 YYYY-MM-DD
 * @returns {{ok:true, dsl:object, signals:object, confidence:number} | {ok:false, error:string, suggestions:string[]}}
 */
function parse(text, opts) {
  const options = opts || {};
  const today = options.today || new Date().toISOString().slice(0, 10);
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return { ok: false, error: '请输入要查询的内容', suggestions: [] };
  if (raw.length > 200) return { ok: false, error: '查询描述请控制在 200 字以内', suggestions: [] };

  const hits = scoreMetrics(raw);
  const top = hits[0];

  // 分数过低视为没听懂：交给模型兜底或提示用户换个说法
  if (!top || top.score < 3) {
    return {
      ok: false,
      error: '没能理解要查哪项统计',
      suggestions: [
        '近 14 天工单量趋势',
        '各意图标签占比',
        '坐席工作量排行',
        '评价分布',
        'FAQ 命中率',
        '未解决工单有哪些',
        '高频知识缺口',
      ],
    };
  }

  const time = detectTime(raw, today);
  const filters = detectFilters(raw, options.agents);
  const limit = detectLimit(raw);

  const dsl = { metric: top.metric, filters };
  if (time && time.days) dsl.days = time.days;
  if (time && time.from) {
    dsl.from = time.from;
    dsl.to = time.to;
  }
  if (limit) dsl.limit = limit;

  // 置信度：主关键词权重 + 是否有时间/过滤条件加持（仅用于可解释输出，不做门禁）
  let confidence = Math.min(0.95, 0.5 + top.score * 0.06);
  if (time) confidence = Math.min(0.97, confidence + 0.05);
  if (Object.keys(filters).length) confidence = Math.min(0.97, confidence + 0.05);

  return {
    ok: true,
    dsl,
    signals: {
      metric: top.metric,
      metricLabel: METRICS[top.metric] ? METRICS[top.metric].label : top.metric,
      keyword: top.word,
      runnersUp: hits.slice(1, 3).map((h) => ({ metric: h.metric, score: h.score })),
      time: time ? time.by : '默认时间窗',
      filters,
    },
    confidence: Number(confidence.toFixed(2)),
  };
}

module.exports = { parse, detectTime, detectFilters, detectLimit, scoreMetrics, METRIC_RULES };
