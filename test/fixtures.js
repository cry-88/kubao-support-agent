/**
 * 测试数据集：构造一份确定性的 store 快照，供单元测试断言统计口径
 *
 * 设计要点：
 *   - 日期全部相对 "今天"（UTC+8）计算，测试不会隔天失效
 *   - 覆盖：三种状态、四种意图、五档评分、两个坐席 + 未分配、FAQ 命中/未命中
 */
'use strict';

function dayKey(today, offset) {
  return new Date(Date.parse(today + 'T00:00:00Z') + offset * 86400000).toISOString().slice(0, 10);
}

function ts(today, offset, hour) {
  const day = dayKey(today, offset);
  const hh = String(hour == null ? 10 : hour).padStart(2, '0');
  return new Date(day + 'T' + hh + ':00:00+08:00').toISOString();
}

function buildDb(today) {
  const T = today;
  const db = {
    settings: [{ key: 'admin_code', value: 'test-admin', updated_at: ts(T, 0, 9) }],
    agents: [
      { id: 1, name: '客服A', code: 'a1', is_active: true, created_at: ts(T, -30, 9), last_seen_at: null },
      { id: 2, name: '客服B', code: 'b1', is_active: true, created_at: ts(T, -30, 9), last_seen_at: null },
    ],
    faqs: [
      { id: 1, question: '退款政策是什么？', answer: '7 天无理由。', category: 'refund', keywords: '退款', priority: 10, enabled: true, created_at: ts(T, -30, 9) },
    ],
    orders: [
      { order_no: 'A2024001', item: '净化器', amount: 1299, status: '已签收', carrier: '顺丰', tracking_no: 'SF1', created_at: ts(T, -6, 9), shipped_at: ts(T, -5, 9), eta: dayKey(T, -2) },
    ],
    conversations: [],
    messages: [],
    login_attempts: [],
    seq: { conversations: 0, messages: 0 },
  };

  const conv = (o) => {
    db.conversations.push(
      Object.assign(
        {
          guest_key: 'guest_' + o.id,
          user_label: '访客' + o.id,
          channel: 'web',
          status: 'active',
          intent: null,
          intent_score: null,
          satisfaction: null,
          feedback: null,
          contact: null,
          message_count: 0,
          handoff_at: null,
          assignee_id: null,
          assignee_name: null,
          claimed_at: null,
          summary: null,
          summary_upto_id: null,
          summary_at: null,
        },
        o
      )
    );
  };

  let mid = 0;
  const msg = (convId, role, content, o) => {
    mid += 1;
    db.messages.push(
      Object.assign(
        { id: mid, conversation_id: convId, role, content, intent: null, meta: {}, created_at: ts(T, -1, 10) },
        o
      )
    );
    return mid;
  };

  // ---- T-1：3 个工单，两个已解决一个待人工 ----
  conv({ id: 1, status: 'closed', intent: 'refund', satisfaction: 5, assignee_id: 1, assignee_name: '客服A', handoff_at: ts(T, -1, 10), claimed_at: ts(T, -1, 10), created_at: ts(T, -1, 9), updated_at: ts(T, -1, 12), message_count: 4 });
  msg(1, 'user', '我要退款，商品还没拆封', { intent: 'refund', meta: { faq_miss: false }, created_at: ts(T, -1, 9) });
  msg(1, 'assistant', '可以，7 天无理由。', { created_at: ts(T, -1, 9) });
  msg(1, 'agent', '已为您提交退款。', { meta: { kind: 'agent', agent_name: '客服A' }, created_at: ts(T, -1, 11) });
  msg(1, 'system', '本会话已由人工客服 客服A 处理完毕。', { meta: { kind: 'resolved' }, created_at: ts(T, -1, 12) });

  conv({ id: 2, status: 'closed', intent: 'order', satisfaction: 4, assignee_id: 2, assignee_name: '客服B', handoff_at: ts(T, -1, 14), claimed_at: ts(T, -1, 14), created_at: ts(T, -1, 13), updated_at: ts(T, -1, 15), message_count: 3 });
  msg(2, 'user', '订单 A2024001 到哪了', { intent: 'order', meta: { faq_miss: false }, created_at: ts(T, -1, 13) });
  msg(2, 'assistant', '已签收。', { created_at: ts(T, -1, 13) });
  msg(2, 'agent', '已为您核实。', { meta: { agent_name: '客服B' }, created_at: ts(T, -1, 15) });

  conv({ id: 3, status: 'handoff', intent: 'tech', handoff_at: ts(T, -1, 16), created_at: ts(T, -1, 15), updated_at: ts(T, -1, 16), message_count: 2 });
  msg(3, 'user', 'App 一打开就闪退怎么办', { intent: 'tech', meta: { faq_miss: false }, created_at: ts(T, -1, 15) });
  msg(3, 'assistant', '请清理缓存重试。', { created_at: ts(T, -1, 15) });

  // ---- T-2：1 个已解决 3 星，含一次 FAQ 未命中 ----
  conv({ id: 4, status: 'closed', intent: 'refund', satisfaction: 3, assignee_id: 1, assignee_name: '客服A', handoff_at: ts(T, -2, 11), claimed_at: ts(T, -2, 11), created_at: ts(T, -2, 10), updated_at: ts(T, -2, 13), message_count: 3 });
  msg(4, 'user', '你们支持开发票吗，能开专票么', { intent: 'other', meta: { faq_miss: true }, created_at: ts(T, -2, 10) });
  msg(4, 'assistant', '抱歉，这个问题我没有把握。', { created_at: ts(T, -2, 10) });
  msg(4, 'agent', '可以开电子专票。', { meta: { agent_name: '客服A' }, created_at: ts(T, -2, 12) });

  // ---- T-3：1 个进行中（无坐席） ----
  conv({ id: 5, status: 'active', intent: 'other', created_at: ts(T, -3, 9), updated_at: ts(T, -3, 9), message_count: 2 });
  msg(5, 'user', '你们老板是谁啊', { intent: 'other', meta: { faq_miss: true }, created_at: ts(T, -3, 9) });
  msg(5, 'assistant', '抱歉，我暂时没有把握。', { created_at: ts(T, -3, 9) });

  // ---- T-20：时间窗外的老数据，用来验证 range 过滤 ----
  conv({ id: 6, status: 'closed', intent: 'order', satisfaction: 1, assignee_id: 2, assignee_name: '客服B', handoff_at: ts(T, -20, 10), claimed_at: ts(T, -20, 10), created_at: ts(T, -20, 9), updated_at: ts(T, -20, 11), message_count: 2 });
  msg(6, 'user', '发货太慢了', { intent: 'order', meta: { faq_miss: false }, created_at: ts(T, -20, 9) });
  msg(6, 'agent', '已催单。', { meta: { agent_name: '客服B' }, created_at: ts(T, -20, 11) });

  db.seq = { conversations: 6, messages: mid };
  return db;
}

module.exports = { buildDb, dayKey, ts };
