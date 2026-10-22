/**
 * RPC 层：对齐 schema.sql 里 28 个 SECURITY DEFINER 函数的行为与返回结构
 * 前端仍然调用 cs_* 名字，这里用参数名（p_xxx）逐一还原，
 * 因此 assets/ 下的业务代码不需要任何改动。
 */
'use strict';

const store = require('./store');

const { md5 } = store;

function nowIso() {
  return new Date().toISOString();
}

function dayKey(isoStr) {
  return store.dateOnly(new Date(isoStr));
}

function todayKey() {
  return store.dateOnly(new Date());
}

function btrim(v) {
  return String(v == null ? '' : v).trim();
}

function secondsSince(isoStr) {
  if (!isoStr) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(isoStr).getTime()) / 1000));
}

function round(n, d) {
  const f = Math.pow(10, d || 0);
  return Math.round(Number(n) * f) / f;
}

function unauthorized() {
  return { ok: false, error: 'unauthorized' };
}

/** 统一身份解析：管理员（operator_id = 0）或坐席 */
function operator(code, db) {
  const setting = db.settings.find((s) => s.key === 'admin_code');
  if (setting && setting.value === code) {
    return { operator_id: 0, operator_name: '管理员', is_admin: true };
  }
  const agent = db.agents.find((a) => a.code === code && a.is_active);
  if (agent) {
    return { operator_id: agent.id, operator_name: agent.name, is_admin: false, agent };
  }
  return null;
}

function isAdmin(code, db) {
  const setting = db.settings.find((s) => s.key === 'admin_code');
  return !!(setting && setting.value === code);
}

function findConversation(db, id) {
  return db.conversations.find((c) => Number(c.id) === Number(id)) || null;
}

function lastMessageOf(db, convId) {
  let last = null;
  for (const m of db.messages) {
    if (Number(m.conversation_id) === Number(convId)) last = m;
  }
  return last;
}

function pushMessage(db, convId, role, content, intent, meta) {
  const id = store.nextId('messages');
  const conv = findConversation(db, convId);
  db.messages.push({
    id,
    conversation_id: Number(convId),
    role,
    content: String(content == null ? '' : content).slice(0, 8000),
    intent: intent || null,
    meta: meta || {},
    created_at: nowIso(),
  });
  if (conv) {
    conv.message_count = Number(conv.message_count || 0) + 1;
    conv.updated_at = nowIso();
    if (intent) conv.intent = intent;
  }
  return id;
}

/* ============================== 访客侧 ============================== */

function csGuestStart(p, db) {
  const guestKey = p.p_guest_key;
  if (!guestKey || String(guestKey).length < 12) {
    return { ok: false, error: 'invalid guest key' };
  }
  const id = store.nextId('conversations');
  const ts = nowIso();
  const conv = {
    id,
    guest_key: String(guestKey),
    user_label: btrim(p.p_user_label) || null,
    channel: 'web',
    status: 'active',
    intent: null,
    intent_score: null,
    satisfaction: null,
    feedback: null,
    contact: null,
    message_count: 1,
    handoff_at: null,
    assignee_id: null,
    assignee_name: null,
    claimed_at: null,
    summary: null,
    summary_upto_id: null,
    summary_at: null,
    created_at: ts,
    updated_at: ts,
  };
  db.conversations.push(conv);
  const msgId = store.nextId('messages');
  db.messages.push({
    id: msgId,
    conversation_id: id,
    role: 'assistant',
    content: '您好，我是哭包～ 退款、订单查询、技术支持都可以问我。请直接描述您遇到的问题。',
    intent: 'other',
    meta: { kind: 'welcome' },
    created_at: ts,
  });
  store.save();
  return { ok: true, conversation_id: id };
}

function csGuestList(p, db) {
  const items = db.conversations
    .filter((c) => c.guest_key === p.p_guest_key)
    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
    .slice(0, 30)
    .map((c) => {
      const last = lastMessageOf(db, c.id);
      return {
        id: c.id,
        status: c.status,
        intent: c.intent,
        satisfaction: c.satisfaction,
        message_count: c.message_count,
        created_at: c.created_at,
        updated_at: c.updated_at,
        last_message: last ? last.content : null,
      };
    });
  return { ok: true, items };
}

function csGuestMessages(p, db) {
  const conv = findConversation(db, p.p_conversation_id);
  if (!conv || conv.guest_key !== p.p_guest_key) {
    return { ok: false, error: 'conversation not found' };
  }
  const items = db.messages
    .filter((m) => Number(m.conversation_id) === Number(conv.id))
    .sort((a, b) => a.id - b.id)
    .map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      intent: m.intent,
      meta: m.meta || {},
      created_at: m.created_at,
    }));
  return { ok: true, items };
}

function csGuestAppend(p, db) {
  const conv = findConversation(db, p.p_conversation_id);
  if (!conv || conv.guest_key !== p.p_guest_key) {
    return { ok: false, error: 'conversation not found' };
  }
  // 服务端硬限流：每访客每分钟 12 条用户消息
  if (p.p_role === 'user') {
    const since = Date.now() - 60 * 1000;
    const recent = db.messages.filter((m) => {
      if (m.role !== 'user') return false;
      if (new Date(m.created_at).getTime() <= since) return false;
      const c = findConversation(db, m.conversation_id);
      return c && c.guest_key === p.p_guest_key;
    }).length;
    if (recent >= 12) return { ok: false, error: 'rate_limited' };
  }
  const id = pushMessage(db, conv.id, p.p_role, p.p_content, p.p_intent, p.p_meta);
  store.save();
  return { ok: true, id };
}

function csGuestUpdate(p, db) {
  const conv = findConversation(db, p.p_conversation_id);
  if (!conv || conv.guest_key !== p.p_guest_key) return { ok: false };
  if (p.p_status) conv.status = p.p_status;
  if (p.p_intent) conv.intent = p.p_intent;
  if (p.p_intent_score != null) conv.intent_score = Number(p.p_intent_score);
  if (p.p_status === 'handoff' && !conv.handoff_at) conv.handoff_at = nowIso();
  conv.updated_at = nowIso();
  store.save();
  return { ok: true };
}

function csGuestRate(p, db) {
  const score = Number(p.p_score);
  if (!score || score < 1 || score > 5) {
    return { ok: false, error: 'score must be between 1 and 5' };
  }
  const conv = findConversation(db, p.p_conversation_id);
  if (!conv || conv.guest_key !== p.p_guest_key) return { ok: false };
  conv.satisfaction = score;
  conv.feedback = btrim(p.p_feedback) || null;
  conv.updated_at = nowIso();
  store.save();
  return { ok: true };
}

function csGuestPoll(p, db) {
  const conv = findConversation(db, p.p_conversation_id);
  if (!conv || conv.guest_key !== p.p_guest_key) {
    return { ok: false, error: 'conversation not found' };
  }
  const after = Number(p.p_after_id) || 0;
  const items = db.messages
    .filter((m) => Number(m.conversation_id) === Number(conv.id) && Number(m.id) > after)
    .sort((a, b) => a.id - b.id)
    .map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      intent: m.intent,
      meta: m.meta || {},
      created_at: m.created_at,
    }));
  return {
    ok: true,
    status: conv.status,
    assignee_name: conv.assignee_name || null,
    summary: conv.summary || null,
    summary_upto_id: Number(conv.summary_upto_id) || 0,
    items,
  };
}

function csGuestContact(p, db) {
  const conv = findConversation(db, p.p_conversation_id);
  if (!conv || conv.guest_key !== p.p_guest_key) return { ok: false };
  conv.contact = btrim(p.p_contact).slice(0, 120);
  conv.updated_at = nowIso();
  store.save();
  return { ok: true };
}

function csGuestSummarySave(p, db) {
  if (!btrim(p.p_summary)) return { ok: false, error: 'empty summary' };
  const conv = findConversation(db, p.p_conversation_id);
  if (!conv || conv.guest_key !== p.p_guest_key) return { ok: false };
  conv.summary = btrim(p.p_summary).slice(0, 1500);
  conv.summary_upto_id = Math.max(Number(conv.summary_upto_id) || 0, Number(p.p_upto_id) || 0);
  conv.summary_at = nowIso();
  store.save();
  return { ok: true };
}

function csLookupOrder(p, db) {
  const no = btrim(p.p_order_no).toUpperCase();
  const o = db.orders.find((x) => x.order_no === no);
  if (!o) return null;
  return {
    order_no: o.order_no,
    item: o.item,
    amount: o.amount,
    status: o.status,
    carrier: o.carrier,
    tracking_no: o.tracking_no,
    created_at: o.created_at,
    shipped_at: o.shipped_at,
    eta: o.eta,
  };
}

/* ============================== 坐席侧 ============================== */

function csConsoleLogin(p, db) {
  const code = String(p.p_code == null ? '' : p.p_code);
  const hash = md5(code);
  const tenMinAgo = Date.now() - 10 * 60 * 1000;
  // 清理一天前的审计记录
  db.login_attempts = db.login_attempts.filter((a) => new Date(a.created_at).getTime() > Date.now() - 24 * 3600 * 1000);

  const globalFail = db.login_attempts.filter(
    (a) => a.ok === false && new Date(a.created_at).getTime() > tenMinAgo
  ).length;
  if (globalFail >= 20) return { ok: false, error: 'too_many_attempts' };

  const codeFail = db.login_attempts.filter(
    (a) => a.ok === false && a.code_hash === hash && new Date(a.created_at).getTime() > tenMinAgo
  ).length;
  if (codeFail >= 5) return { ok: false, error: 'too_many_attempts' };

  const who = operator(code, db);
  if (!who) {
    db.login_attempts.push({ id: store.nextId('login_attempts'), code_hash: hash, ok: false, created_at: nowIso() });
    store.save();
    return { ok: false, error: 'unauthorized' };
  }
  db.login_attempts.push({ id: store.nextId('login_attempts'), code_hash: hash, ok: true, created_at: nowIso() });
  if (who.agent) who.agent.last_seen_at = nowIso();
  store.save();
  return { ok: true, agent_id: who.operator_id, name: who.operator_name, is_admin: who.is_admin };
}

function queueRow(db, c, field) {
  const last = lastMessageOf(db, c.id);
  return {
    id: c.id,
    user_label: c.user_label || '访客',
    intent: c.intent,
    status: c.status,
    contact: c.contact,
    assignee_name: c.assignee_name,
    claimed_at: c.claimed_at,
    handoff_at: c.handoff_at,
    message_count: c.message_count,
    satisfaction: c.satisfaction,
    wait_seconds: secondsSince(c[field] || c.updated_at),
    last_message: last ? last.content : null,
  };
}

function csAgentQueue(p, db) {
  const who = operator(p.p_code, db);
  if (!who) return unauthorized();
  if (who.agent) who.agent.last_seen_at = nowIso();

  const waiting = db.conversations
    .filter((c) => c.status === 'handoff' && c.assignee_id == null)
    .map((c) => queueRow(db, c, 'handoff_at'))
    .sort((a, b) => b.wait_seconds - a.wait_seconds);

  const mine = db.conversations
    .filter((c) => c.status === 'handoff' && Number(c.assignee_id) === Number(who.operator_id))
    .map((c) => queueRow(db, c, 'claimed_at'))
    .sort((a, b) => new Date(a.claimed_at || 0) - new Date(b.claimed_at || 0));

  const others = db.conversations
    .filter(
      (c) =>
        c.status === 'handoff' && c.assignee_id != null && Number(c.assignee_id) !== Number(who.operator_id)
    )
    .map((c) => queueRow(db, c, 'claimed_at'))
    .sort((a, b) => new Date(a.claimed_at || 0) - new Date(b.claimed_at || 0));

  const resolvedToday = db.conversations.filter(
    (c) => c.status === 'closed' && dayKey(c.updated_at) === todayKey()
  ).length;

  store.save();
  return {
    ok: true,
    me: { id: who.operator_id, name: who.operator_name, is_admin: who.is_admin },
    waiting,
    mine,
    others,
    resolved_today: resolvedToday,
  };
}

function csAgentClaim(p, db) {
  const who = operator(p.p_code, db);
  if (!who) return unauthorized();

  const conv = findConversation(db, p.p_conversation_id);
  if (!conv || conv.status !== 'handoff') return { ok: false, error: 'not_in_queue' };
  if (conv.assignee_id != null && Number(conv.assignee_id) !== Number(who.operator_id)) {
    return { ok: false, error: 'claimed_by_other', assignee: conv.assignee_name || '其他客服' };
  }
  conv.assignee_id = who.operator_id;
  conv.assignee_name = who.operator_name;
  conv.claimed_at = conv.claimed_at || nowIso();
  conv.updated_at = nowIso();
  store.save();
  return { ok: true, assignee: who.operator_name };
}

function csAgentRelease(p, db) {
  const who = operator(p.p_code, db);
  if (!who) return unauthorized();
  const conv = findConversation(db, p.p_conversation_id);
  if (!conv || Number(conv.assignee_id) !== Number(who.operator_id) || conv.status !== 'handoff') {
    return { ok: false };
  }
  conv.assignee_id = null;
  conv.assignee_name = null;
  conv.claimed_at = null;
  conv.updated_at = nowIso();
  store.save();
  return { ok: true };
}

function conversationForAgent(c, full) {
  const v = {
    id: c.id,
    status: c.status,
    intent: c.intent,
    satisfaction: c.satisfaction,
    feedback: c.feedback,
    contact: c.contact,
    created_at: c.created_at,
    user_label: c.user_label,
    summary: c.summary,
    summary_upto_id: c.summary_upto_id,
  };
  if (full) {
    v.assignee_id = c.assignee_id;
    v.assignee_name = c.assignee_name;
    v.claimed_at = c.claimed_at;
  }
  return v;
}

function csAgentMessages(p, db) {
  const who = operator(p.p_code, db);
  if (!who) return unauthorized();
  const conv = findConversation(db, p.p_conversation_id);
  if (!conv) return { ok: false, error: 'conversation not found' };
  const items = db.messages
    .filter((m) => Number(m.conversation_id) === Number(conv.id))
    .sort((a, b) => a.id - b.id)
    .map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      intent: m.intent,
      meta: m.meta || {},
      created_at: m.created_at,
    }));
  return {
    ok: true,
    me: { id: who.operator_id, name: who.operator_name, is_admin: who.is_admin },
    conversation: conversationForAgent(conv, true),
    items,
  };
}

function csAgentReply(p, db) {
  const who = operator(p.p_code, db);
  if (!who) return unauthorized();
  if (!btrim(p.p_content)) return { ok: false, error: 'empty content' };
  const conv = findConversation(db, p.p_conversation_id);
  if (!conv) return { ok: false, error: 'conversation not found' };

  const id = pushMessage(db, conv.id, 'agent', String(p.p_content).slice(0, 4000), null, {
    kind: 'agent',
    agent_name: who.operator_name,
  });
  conv.assignee_id = conv.assignee_id == null ? who.operator_id : conv.assignee_id;
  conv.assignee_name = conv.assignee_name || who.operator_name;
  conv.claimed_at = conv.claimed_at || nowIso();
  store.save();
  return { ok: true, id, agent_name: who.operator_name };
}

function csAgentResolve(p, db) {
  const who = operator(p.p_code, db);
  if (!who) return unauthorized();
  const conv = findConversation(db, p.p_conversation_id);
  if (!conv) return { ok: false, error: 'conversation not found' };
  conv.status = 'closed';
  conv.assignee_id = conv.assignee_id == null ? who.operator_id : conv.assignee_id;
  conv.assignee_name = conv.assignee_name || who.operator_name;
  conv.claimed_at = conv.claimed_at || nowIso();
  pushMessage(db, conv.id, 'system', '本会话已由人工客服 ' + who.operator_name + ' 处理完毕。', null, {
    kind: 'resolved',
    agent_name: who.operator_name,
  });
  store.save();
  return { ok: true };
}

/* ============================== 管理侧 ============================== */

function csAdminStats(p, db) {
  if (!isAdmin(p.p_code, db)) return unauthorized();
  const convs = db.conversations;
  const rated = convs.filter((c) => c.satisfaction != null);
  const scoreDist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  rated.forEach((c) => {
    const k = String(c.satisfaction);
    if (scoreDist[k] != null) scoreDist[k] += 1;
  });
  const avgScore = rated.length ? round(rated.reduce((s, c) => s + c.satisfaction, 0) / rated.length, 2) : 0;
  const good = rated.filter((c) => c.satisfaction >= 4).length;
  const satisfiedRate = rated.length ? round((good * 100) / rated.length, 1) : 0;

  const intentMap = {};
  convs.forEach((c) => {
    const k = c.intent || 'unknown';
    intentMap[k] = (intentMap[k] || 0) + 1;
  });
  const intentCounts = Object.keys(intentMap)
    .map((k) => ({ intent: k, count: intentMap[k] }))
    .sort((a, b) => b.count - a.count);

  const statusMap = {};
  convs.forEach((c) => {
    statusMap[c.status] = (statusMap[c.status] || 0) + 1;
  });
  const statusCounts = Object.keys(statusMap)
    .map((k) => ({ status: k, count: statusMap[k] }))
    .sort((a, b) => b.count - a.count);

  const daily = [];
  for (let i = 13; i >= 0; i -= 1) {
    const key = store.dateOnly(store.daysFromNow(-i));
    const dayConvs = convs.filter((c) => dayKey(c.created_at) === key);
    const dayRated = dayConvs.filter((c) => c.satisfaction != null);
    daily.push({
      day: key,
      conversations: dayConvs.length,
      rated: dayRated.length,
      avg_score: dayRated.length ? round(dayRated.reduce((s, c) => s + c.satisfaction, 0) / dayRated.length, 2) : 0,
    });
  }

  return {
    ok: true,
    total_conversations: convs.length,
    total_messages: db.messages.length,
    today_conversations: convs.filter((c) => dayKey(c.created_at) === todayKey()).length,
    rated_count: rated.length,
    avg_score: avgScore,
    satisfied_rate: satisfiedRate,
    handoff_count: convs.filter((c) => c.handoff_at).length,
    pending_handoff: convs.filter((c) => c.status === 'handoff').length,
    score_dist: scoreDist,
    intent_counts: intentCounts,
    status_counts: statusCounts,
    daily,
  };
}

function csAdminConversations(p, db) {
  if (!isAdmin(p.p_code, db)) return unauthorized();
  const status = p.p_status || 'all';
  const limit = Math.max(Number(p.p_limit) || 50, 1);
  const offset = Math.max(Number(p.p_offset) || 0, 0);
  const all = db.conversations
    .filter((c) => status === 'all' || c.status === status)
    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  const items = all.slice(offset, offset + limit).map((c) => {
    const last = lastMessageOf(db, c.id);
    return {
      id: c.id,
      guest_key_mask: String(c.guest_key).slice(0, 8) + '***',
      user_label: c.user_label,
      status: c.status,
      intent: c.intent,
      satisfaction: c.satisfaction,
      feedback: c.feedback,
      message_count: c.message_count,
      created_at: c.created_at,
      updated_at: c.updated_at,
      handoff_at: c.handoff_at,
      assignee_name: c.assignee_name,
      contact: c.contact,
      last_message: last ? last.content : null,
      last_role: last ? last.role : null,
    };
  });
  return { ok: true, total: all.length, items };
}

function csAdminMessages(p, db) {
  if (!isAdmin(p.p_code, db)) return unauthorized();
  const conv = findConversation(db, p.p_conversation_id);
  if (!conv) return { ok: false, error: 'conversation not found' };
  const items = db.messages
    .filter((m) => Number(m.conversation_id) === Number(conv.id))
    .sort((a, b) => a.id - b.id)
    .map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      intent: m.intent,
      meta: m.meta || {},
      created_at: m.created_at,
    }));
  return { ok: true, conversation: conversationForAgent(conv, false), items };
}

function csAdminReply(p, db) {
  if (!isAdmin(p.p_code, db)) return unauthorized();
  if (!btrim(p.p_content)) return { ok: false, error: 'empty content' };
  const conv = findConversation(db, p.p_conversation_id);
  if (!conv) return { ok: false, error: 'conversation not found' };
  const id = pushMessage(db, conv.id, 'agent', String(p.p_content).slice(0, 4000), null, { kind: 'agent' });
  store.save();
  return { ok: true, id };
}

function csAdminResolve(p, db) {
  if (!isAdmin(p.p_code, db)) return unauthorized();
  const conv = findConversation(db, p.p_conversation_id);
  if (!conv) return { ok: false, error: 'conversation not found' };
  const resolved = p.p_resolved !== false;
  conv.status = resolved ? 'closed' : 'handoff';
  if (resolved) {
    pushMessage(db, conv.id, 'system', '本会话已由人工客服处理完毕。', null, { kind: 'resolved' });
  } else {
    conv.updated_at = nowIso();
  }
  store.save();
  return { ok: true };
}

function csAdminFaqList(p, db) {
  if (!isAdmin(p.p_code, db)) return unauthorized();
  const items = db.faqs
    .slice()
    .sort((a, b) => (b.priority || 0) - (a.priority || 0) || a.id - b.id);
  return { ok: true, items };
}

function csAdminFaqSave(p, db) {
  if (!isAdmin(p.p_code, db)) return unauthorized();
  if (!btrim(p.p_question) || !btrim(p.p_answer)) {
    return { ok: false, error: 'question and answer required' };
  }
  const payload = {
    question: btrim(p.p_question),
    answer: btrim(p.p_answer),
    category: p.p_category || 'general',
    keywords: p.p_keywords || '',
    priority: Number(p.p_priority) || 0,
    enabled: p.p_enabled !== false,
  };
  if (p.p_id == null) {
    const id = store.nextId('faqs');
    db.faqs.push(Object.assign({ id, created_at: nowIso() }, payload));
    store.save();
    return { ok: true, id };
  }
  const faq = db.faqs.find((f) => Number(f.id) === Number(p.p_id));
  if (!faq) return { ok: false, error: 'faq not found' };
  Object.assign(faq, payload);
  store.save();
  return { ok: true, id: faq.id };
}

function csAdminFaqDelete(p, db) {
  if (!isAdmin(p.p_code, db)) return unauthorized();
  const idx = db.faqs.findIndex((f) => Number(f.id) === Number(p.p_id));
  if (idx < 0) return { ok: false };
  db.faqs.splice(idx, 1);
  store.save();
  return { ok: true };
}

function csAdminGaps(p, db) {
  if (!isAdmin(p.p_code, db)) return unauthorized();
  const days = Number(p.p_days) || 30;
  const since = Date.now() - days * 24 * 3600 * 1000;
  const map = new Map();
  db.messages.forEach((m) => {
    if (m.role !== 'user') return;
    const meta = m.meta || {};
    const miss = meta.faq_miss === true || meta.faq_miss === 'true';
    if (!miss) return;
    if (new Date(m.created_at).getTime() <= since) return;
    const q = btrim(m.content);
    if (q.length < 4) return;
    const row = map.get(q);
    if (row) {
      row.cnt += 1;
      if (new Date(m.created_at) > new Date(row.last_seen)) row.last_seen = m.created_at;
      row.intent = m.intent || row.intent;
    } else {
      map.set(q, { question: q, cnt: 1, last_seen: m.created_at, intent: m.intent || null });
    }
  });
  const items = Array.from(map.values())
    .sort((a, b) => b.cnt - a.cnt || new Date(b.last_seen) - new Date(a.last_seen))
    .slice(0, 30);
  return { ok: true, items };
}

function csAdminExport(p, db) {
  if (!isAdmin(p.p_code, db)) return unauthorized();
  const status = p.p_status || 'all';
  const convs = db.conversations
    .filter((c) => status === 'all' || c.status === status)
    .sort((a, b) => b.id - a.id);
  const items = [];
  for (const c of convs) {
    const msgs = db.messages.filter((m) => Number(m.conversation_id) === Number(c.id)).sort((a, b) => a.id - b.id);
    for (const m of msgs) {
      items.push({
        conversation_id: c.id,
        user_label: c.user_label || '访客',
        status: c.status,
        conv_intent: c.intent,
        satisfaction: c.satisfaction,
        feedback: c.feedback,
        contact: c.contact,
        id: m.id,
        role: m.role,
        content: m.content,
        intent: m.intent,
        created_at: m.created_at,
      });
      if (items.length >= 5000) break;
    }
    if (items.length >= 5000) break;
  }
  return { ok: true, items };
}

/* ============================== 分发 ============================== */

const HANDLERS = {
  cs_guest_start: csGuestStart,
  cs_guest_list: csGuestList,
  cs_guest_messages: csGuestMessages,
  cs_guest_append: csGuestAppend,
  cs_guest_update: csGuestUpdate,
  cs_guest_rate: csGuestRate,
  cs_guest_poll: csGuestPoll,
  cs_guest_contact: csGuestContact,
  cs_guest_summary_save: csGuestSummarySave,
  cs_lookup_order: csLookupOrder,
  cs_console_login: csConsoleLogin,
  cs_agent_queue: csAgentQueue,
  cs_agent_claim: csAgentClaim,
  cs_agent_release: csAgentRelease,
  cs_agent_messages: csAgentMessages,
  cs_agent_reply: csAgentReply,
  cs_agent_resolve: csAgentResolve,
  cs_admin_stats: csAdminStats,
  cs_admin_conversations: csAdminConversations,
  cs_admin_messages: csAdminMessages,
  cs_admin_reply: csAdminReply,
  cs_admin_resolve: csAdminResolve,
  cs_admin_faq_list: csAdminFaqList,
  cs_admin_faq_save: csAdminFaqSave,
  cs_admin_faq_delete: csAdminFaqDelete,
  cs_admin_gaps: csAdminGaps,
  cs_admin_export: csAdminExport,
};

function call(name, params) {
  const fn = HANDLERS[name];
  if (!fn) return { ok: false, error: 'unknown function: ' + name };
  return fn(params || {}, store.db);
}

module.exports = { call, HANDLERS };
