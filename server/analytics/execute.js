/**
 * 数据分析 · 只读执行器
 *
 * 约束：
 *   - 纯函数：入参 (dsl, db, todayKey)，不写库、不落盘、不改任何业务数据
 *   - 分派执行：每个指标一个函数，不存在动态代码/字符串拼接
 *   - 行数受 DSL.limit 与 MAX_LIMIT 双重限制
 */
'use strict';

const dslLib = require('./dsl');

const { INTENT_LABELS, STATUS_LABELS, METRICS } = dslLib;

function dayKeyOf(iso) {
  if (!iso) return null;
  return new Date(new Date(iso).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function round(n, d) {
  const f = Math.pow(10, d == null ? 1 : d);
  return Math.round(Number(n) * f) / f;
}

function pct(a, b) {
  if (!b) return 0;
  return round((a * 100) / b, 1);
}

function secondsBetween(a, b) {
  if (!a || !b) return null;
  return Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000));
}

function inRange(day, from, to) {
  return !!day && day >= from && day <= to;
}

function dayList(from, to) {
  const out = [];
  const end = Date.parse(to + 'T00:00:00Z');
  for (let t = Date.parse(from + 'T00:00:00Z'); t <= end; t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** 会话级过滤：状态 / 意图 / 坐席 */
function matchConv(conv, filters) {
  if (filters.status && conv.status !== filters.status) return false;
  if (filters.intent && (conv.intent || 'unknown') !== filters.intent) return false;
  if (filters.agent && conv.assignee_name !== filters.agent) return false;
  return true;
}

function messagesOf(db, convId) {
  return db.messages.filter((m) => Number(m.conversation_id) === Number(convId));
}

function lastMessage(db, convId) {
  let last = null;
  for (const m of db.messages) {
    if (Number(m.conversation_id) === Number(convId)) last = m;
  }
  return last;
}

function convsInRange(db, range, filters) {
  return db.conversations.filter((c) => matchConv(c, filters) && inRange(dayKeyOf(c.created_at), range.from, range.to));
}

/* ----------------------------- 指标实现 ----------------------------- */

function ticketTrend(ctx) {
  const { db, dsl, range } = ctx;
  const days = dayList(range.from, range.to);
  const convs = convsInRange(db, range, dsl.filters);
  const rowMap = new Map();
  days.forEach((d) => rowMap.set(d, { day: d, conversations: 0, handoff: 0, closed: 0, rated: 0, score_sum: 0 }));

  for (const c of convs) {
    const row = rowMap.get(dayKeyOf(c.created_at));
    if (!row) continue;
    row.conversations += 1;
    if (c.satisfaction != null) {
      row.rated += 1;
      row.score_sum += Number(c.satisfaction);
    }
  }
  for (const c of db.conversations) {
    if (!matchConv(c, dsl.filters)) continue;
    const h = dayKeyOf(c.handoff_at);
    if (h && rowMap.has(h)) rowMap.get(h).handoff += 1;
    if (c.status === 'closed') {
      const cl = dayKeyOf(c.updated_at);
      if (cl && rowMap.has(cl)) rowMap.get(cl).closed += 1;
    }
  }

  const rows = days.map((d) => {
    const r = rowMap.get(d);
    return {
      day: d,
      conversations: r.conversations,
      handoff: r.handoff,
      closed: r.closed,
      rated: r.rated,
      avg_score: r.rated ? round(r.score_sum / r.rated, 2) : 0,
    };
  });

  const total = rows.reduce((s, r) => s + r.conversations, 0);
  const peak = rows.reduce((a, b) => (b.conversations > a.conversations ? b : a), rows[0] || { conversations: 0, day: '-' });
  const handoffSum = rows.reduce((s, r) => s + r.handoff, 0);
  const closedSum = rows.reduce((s, r) => s + r.closed, 0);

  return {
    columns: [
      { key: 'day', label: '日期' },
      { key: 'conversations', label: '新建工单', align: 'right' },
      { key: 'handoff', label: '转人工', align: 'right' },
      { key: 'closed', label: '已解决', align: 'right' },
      { key: 'rated', label: '已评价', align: 'right' },
      { key: 'avg_score', label: '平均分', align: 'right' },
    ],
    rows,
    total,
    summary:
      range.from === range.to
        ? range.from + ' 新建工单 ' + total + ' 条，转人工 ' + handoffSum + ' 次，已解决 ' + closedSum + ' 条。'
        : range.from + ' 至 ' + range.to + ' 共新建工单 ' + total + ' 条，日均 ' + round(total / Math.max(range.days, 1), 1) +
          ' 条；峰值在 ' + peak.day + '（' + peak.conversations + ' 条）；期内转人工 ' + handoffSum + ' 次，已解决 ' + closedSum + ' 条。',
  };
}

function intentShare(ctx) {
  const { db, dsl, range } = ctx;
  const convs = convsInRange(db, range, dsl.filters);
  const map = new Map();
  for (const c of convs) {
    const k = c.intent || 'unknown';
    map.set(k, (map.get(k) || 0) + 1);
  }
  const total = convs.length;
  const rows = Array.from(map.entries())
    .map(([intent, count]) => ({ intent, label: INTENT_LABELS[intent] || intent, count, pct: pct(count, total) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, dsl.limit);

  const top = rows[0];
  return {
    columns: [
      { key: 'intent', label: '意图编码' },
      { key: 'label', label: '意图' },
      { key: 'count', label: '工单数', align: 'right' },
      { key: 'pct', label: '占比 %', align: 'right' },
    ],
    rows,
    total,
    summary: total
      ? '期内共 ' + total + ' 个工单，占比最高的是「' + top.label + '」（' + top.count + ' 条，' + top.pct + '%）。'
      : '期内没有符合条件的工单。',
  };
}

function agentWorkload(ctx) {
  const { db, dsl, range } = ctx;
  const convs = convsInRange(db, range, { status: dsl.filters.status, intent: dsl.filters.intent });
  const names = new Set();
  (db.agents || []).forEach((a) => names.add(a.name));
  convs.forEach((c) => {
    if (c.assignee_name) names.add(c.assignee_name);
  });

  const rows = [];
  for (const name of names) {
    if (dsl.filters.agent && name !== dsl.filters.agent) continue;
    const mine = convs.filter((c) => c.assignee_name === name);
    const resolved = mine.filter((c) => c.status === 'closed');
    const rated = mine.filter((c) => c.satisfaction != null);
    const good = rated.filter((c) => Number(c.satisfaction) >= 4);

    // 首次响应：认领时间 → 该会话第一条 agent 消息
    const fr = [];
    for (const c of mine) {
      if (!c.claimed_at) continue;
      const firstAgent = messagesOf(db, c.id)
        .filter((m) => m.role === 'agent')
        .sort((a, b) => a.id - b.id)[0];
      const s = secondsBetween(c.claimed_at, firstAgent ? firstAgent.created_at : null);
      if (s != null) fr.push(s);
    }

    rows.push({
      agent: name,
      claimed: mine.length,
      resolved: resolved.length,
      resolve_rate: pct(resolved.length, mine.length),
      avg_first_response: fr.length ? Math.round(fr.reduce((a, b) => a + b, 0) / fr.length) : null,
      rated: rated.length,
      avg_score: rated.length ? round(rated.reduce((s, c) => s + Number(c.satisfaction), 0) / rated.length, 2) : 0,
      good_rate: pct(good.length, rated.length),
    });
  }

  rows.sort((a, b) => b.claimed - a.claimed || b.resolved - a.resolved);
  const limited = rows.slice(0, dsl.limit);
  const totalClaimed = rows.reduce((s, r) => s + r.claimed, 0);
  const top = limited[0];

  return {
    columns: [
      { key: 'agent', label: '坐席' },
      { key: 'claimed', label: '接单量', align: 'right' },
      { key: 'resolved', label: '已解决', align: 'right' },
      { key: 'resolve_rate', label: '解决率 %', align: 'right' },
      { key: 'avg_first_response', label: '平均首响(秒)', align: 'right' },
      { key: 'rated', label: '评价数', align: 'right' },
      { key: 'avg_score', label: '平均分', align: 'right' },
      { key: 'good_rate', label: '好评率 %', align: 'right' },
    ],
    rows: limited,
    total: totalClaimed,
    summary: totalClaimed
      ? '期内坐席共接单 ' + totalClaimed + ' 件，接单最多的是「' + top.agent + '」（' + top.claimed + ' 件，解决率 ' + top.resolve_rate + '%）。'
      : '期内还没有坐席接单记录。',
  };
}

function ratingDist(ctx) {
  const { db, dsl, range } = ctx;
  const convs = convsInRange(db, range, dsl.filters).filter((c) => c.satisfaction != null);
  const total = convs.length;
  const rows = [];
  for (let s = 5; s >= 1; s -= 1) {
    const count = convs.filter((c) => Number(c.satisfaction) === s).length;
    rows.push({ score: s, count, pct: pct(count, total) });
  }
  const sum = convs.reduce((a, c) => a + Number(c.satisfaction), 0);
  const good = convs.filter((c) => Number(c.satisfaction) >= 4).length;
  const avg = total ? round(sum / total, 2) : 0;

  return {
    columns: [
      { key: 'score', label: '星级', align: 'right' },
      { key: 'count', label: '数量', align: 'right' },
      { key: 'pct', label: '占比 %', align: 'right' },
    ],
    rows,
    total,
    summary: total
      ? '期内 ' + total + ' 条评价，平均 ' + avg + ' 分，好评率（4 星及以上）' + pct(good, total) + '%。'
      : '期内没有用户提交评价。',
    extra: { avg_score: avg, rated_count: total, satisfied_rate: pct(good, total) },
  };
}

function faqHitRate(ctx) {
  const { db, dsl, range } = ctx;
  const rowMap = new Map();
  dayList(range.from, range.to).forEach((d) => rowMap.set(d, { day: d, hits: 0, misses: 0 }));

  let hits = 0;
  let misses = 0;
  for (const m of db.messages) {
    if (m.role !== 'user') continue;
    const meta = m.meta || {};
    if (meta.faq_miss === undefined || meta.faq_miss === null) continue;
    const day = dayKeyOf(m.created_at);
    if (!inRange(day, range.from, range.to)) continue;
    const miss = meta.faq_miss === true || meta.faq_miss === 'true';
    const row = rowMap.get(day);
    if (miss) {
      misses += 1;
      if (row) row.misses += 1;
    } else {
      hits += 1;
      if (row) row.hits += 1;
    }
  }

  const rows = Array.from(rowMap.values()).map((r) => {
    const total = r.hits + r.misses;
    return { day: r.day, hits: r.hits, misses: r.misses, total, hit_rate: pct(r.hits, total) };
  });
  const total = hits + misses;

  return {
    columns: [
      { key: 'day', label: '日期' },
      { key: 'hits', label: '命中', align: 'right' },
      { key: 'misses', label: '未命中', align: 'right' },
      { key: 'total', label: '提问数', align: 'right' },
      { key: 'hit_rate', label: '命中率 %', align: 'right' },
    ],
    rows,
    total,
    summary: total
      ? '期内用户提问 ' + total + ' 次，FAQ 命中 ' + hits + ' 次，命中率 ' + pct(hits, total) + '%；未命中 ' + misses + ' 次可去「知识缺口」补齐。'
      : '期内没有可用于统计命中率的提问。',
    extra: { hit_rate: pct(hits, total) },
  };
}

function unresolved(ctx) {
  const { db, dsl } = ctx;
  const now = Date.now();
  const list = db.conversations
    .filter((c) => c.status === 'active' || c.status === 'handoff')
    .filter((c) => matchConv(c, dsl.filters))
    .map((c) => {
      const last = lastMessage(db, c.id);
      const since = c.handoff_at || c.claimed_at || c.updated_at;
      return {
        id: c.id,
        status: c.status,
        status_label: STATUS_LABELS[c.status] || c.status,
        intent: c.intent || 'unknown',
        intent_label: INTENT_LABELS[c.intent] || '未识别',
        user_label: c.user_label || '访客',
        assignee_name: c.assignee_name || '',
        wait_seconds: Math.max(0, Math.round((now - new Date(since).getTime()) / 1000)),
        created_at: c.created_at,
        last_message: last ? String(last.content).slice(0, 80) : '',
      };
    })
    .sort((a, b) => b.wait_seconds - a.wait_seconds);

  const rows = dsl.order === 'asc' ? list.slice().reverse() : list;
  const limited = rows.slice(0, dsl.limit);
  const waiting = list.filter((r) => r.status === 'handoff').length;

  return {
    columns: [
      { key: 'id', label: '工单号', align: 'right' },
      { key: 'status_label', label: '状态' },
      { key: 'intent_label', label: '意图' },
      { key: 'user_label', label: '访客' },
      { key: 'assignee_name', label: '处理人' },
      { key: 'wait_seconds', label: '已等待(秒)', align: 'right' },
      { key: 'last_message', label: '最后一条' },
    ],
    rows: limited,
    total: list.length,
    summary: list.length
      ? '当前有 ' + list.length + ' 个未解决工单，其中待人工 ' + waiting + ' 个；等待最久的是 #' + list[0].id + '（' + list[0].wait_seconds + ' 秒）。'
      : '当前没有未解决工单。',
    note: '该指标反映当前状态，不受时间窗限制',
  };
}

function knowledgeGaps(ctx) {
  const { db, dsl, range } = ctx;
  const map = new Map();
  for (const m of db.messages) {
    if (m.role !== 'user') continue;
    const meta = m.meta || {};
    const miss = meta.faq_miss === true || meta.faq_miss === 'true';
    if (!miss) continue;
    if (!inRange(dayKeyOf(m.created_at), range.from, range.to)) continue;
    const q = String(m.content || '').trim();
    if (q.length < 4) continue;
    const row = map.get(q);
    if (row) {
      row.cnt += 1;
      if (new Date(m.created_at) > new Date(row.last_seen)) row.last_seen = m.created_at;
      if (m.intent) row.intent = m.intent;
    } else {
      map.set(q, { question: q, cnt: 1, last_seen: m.created_at, intent: m.intent || 'unknown' });
    }
  }
  const all = Array.from(map.values()).sort((a, b) => b.cnt - a.cnt || new Date(b.last_seen) - new Date(a.last_seen));
  const rows = all.slice(0, dsl.limit).map((r) => ({
    question: r.question,
    cnt: r.cnt,
    intent: r.intent,
    intent_label: INTENT_LABELS[r.intent] || '未识别',
    last_seen: new Date(new Date(r.last_seen).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' '),
  }));

  return {
    columns: [
      { key: 'question', label: '未命中提问' },
      { key: 'cnt', label: '出现次数', align: 'right' },
      { key: 'intent_label', label: '意图' },
      { key: 'last_seen', label: '最近出现' },
    ],
    rows,
    total: all.length,
    summary: all.length
      ? '期内有 ' + all.length + ' 类提问没命中知识库，出现最多的是「' + all[0].question.slice(0, 24) + '」（' + all[0].cnt + ' 次）。'
      : '期内没有未命中的提问，知识库覆盖得不错。',
  };
}

function overview(ctx) {
  const { db, dsl, range } = ctx;
  const convs = convsInRange(db, range, dsl.filters);
  const open = db.conversations.filter((c) => c.status === 'active' || c.status === 'handoff').length;
  const waiting = db.conversations.filter((c) => c.status === 'handoff').length;
  const rated = convs.filter((c) => c.satisfaction != null);
  const avg = rated.length ? round(rated.reduce((s, c) => s + Number(c.satisfaction), 0) / rated.length, 2) : 0;

  let hits = 0;
  let totalAsk = 0;
  for (const m of db.messages) {
    if (m.role !== 'user') continue;
    const meta = m.meta || {};
    if (meta.faq_miss === undefined || meta.faq_miss === null) continue;
    if (!inRange(dayKeyOf(m.created_at), range.from, range.to)) continue;
    totalAsk += 1;
    if (!(meta.faq_miss === true || meta.faq_miss === 'true')) hits += 1;
  }

  const intentMap = new Map();
  convs.forEach((c) => {
    const k = c.intent || 'unknown';
    intentMap.set(k, (intentMap.get(k) || 0) + 1);
  });
  const topIntent = Array.from(intentMap.entries()).sort((a, b) => b[1] - a[1])[0];

  const row = {
    period: range.from + ' ~ ' + range.to,
    conversations: convs.length,
    open,
    waiting,
    avg_score: avg,
    faq_hit_rate: pct(hits, totalAsk),
    top_intent: topIntent ? (INTENT_LABELS[topIntent[0]] || topIntent[0]) : '—',
  };

  return {
    columns: [
      { key: 'period', label: '统计区间' },
      { key: 'conversations', label: '新建工单', align: 'right' },
      { key: 'open', label: '未解决', align: 'right' },
      { key: 'waiting', label: '待人工', align: 'right' },
      { key: 'avg_score', label: '平均分', align: 'right' },
      { key: 'faq_hit_rate', label: 'FAQ 命中率 %', align: 'right' },
      { key: 'top_intent', label: 'Top 意图' },
    ],
    rows: [row],
    total: convs.length,
    summary:
      '期内新建 ' + convs.length + ' 个工单，当前未解决 ' + open + ' 个（待人工 ' + waiting + ' 个），平均满意度 ' + avg +
      ' 分，FAQ 命中率 ' + pct(hits, totalAsk) + '%，主要意图是「' + row.top_intent + '」。',
  };
}

const RUNNERS = {
  ticket_trend: ticketTrend,
  intent_share: intentShare,
  agent_workload: agentWorkload,
  rating_dist: ratingDist,
  faq_hit_rate: faqHitRate,
  unresolved,
  knowledge_gaps: knowledgeGaps,
  overview,
};

/**
 * @param {object} dsl 已通过 dsl.normalize 的查询
 * @param {object} db 数据快照（只读）
 * @param {string} todayKey UTC+8 的 YYYY-MM-DD
 */
function run(dsl, db, todayKey) {
  const runner = RUNNERS[dsl.metric];
  if (!runner) return { ok: false, error: '不支持的指标：' + dsl.metric };
  const range = dslLib.range(dsl, todayKey);
  const result = runner({ dsl, db, range, todayKey });
  return {
    ok: true,
    metric: dsl.metric,
    metric_label: METRICS[dsl.metric].label,
    range: { from: range.from, to: range.to, days: range.days },
    columns: result.columns,
    rows: result.rows,
    total: result.total,
    summary: result.summary,
    extra: result.extra || null,
    note: result.note || null,
    read_only: true,
  };
}

module.exports = { run, dayKeyOf, RUNNERS, pct, round, dayList };
