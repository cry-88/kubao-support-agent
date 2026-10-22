/* 哭包 · 聊天页逻辑 */
(function () {
  'use strict';

  var CS = window.CS;
  var unwrap = window.unwrapRpc;
  var guestKey = window.getGuestKey();
  var $ = function (id) { return document.getElementById(id); };

  var el = {
    messages: $('messages'),
    convList: $('convList'),
    input: $('input'),
    sendBtn: $('sendBtn'),
    stopWrap: $('stopWrap'),
    newChatBtn: $('newChatBtn'),
    endBtn: $('endBtn'),
    statusText: $('statusText'),
    statusDot: $('statusDot'),
    intentPill: $('intentPill'),
    summaryPill: $('summaryPill'),
    bannerWrap: $('bannerWrap'),
    ratingWrap: $('ratingWrap'),
    guestLabel: $('guestLabel'),
    modelHint: $('modelHint'),
    toast: $('toast'),
  };

  var state = {
    cloud: null,
    faqs: [],
    model: null,
    conversations: [],
    conversationId: null,
    messages: [],
    lastId: 0,
    status: 'active',
    intent: null,
    assigneeName: null,
    summary: null,
    summaryUpto: 0,
    summarizing: false,
    satisfaction: null,
    rated: false,
    streaming: false,
    controller: null,
    pollTimer: null,
    lowConf: 0,
    lastSendAt: 0,
    sendTimes: [],
    preview: false,
    label: '访客 ' + guestKey.slice(0, 4).toUpperCase(),
  };

  /* ---------- 工具 ---------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function rich(s) {
    return esc(s).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  }
  var toastTimer = null;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.classList.remove('show'); }, 2600);
  }
  function scrollBottom() {
    el.messages.scrollTop = el.messages.scrollHeight;
  }
  function timeStr(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    var now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    var hm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    if (sameDay) return hm;
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
  }
  function intentLabel(key) {
    return (CS.INTENTS[key] || CS.INTENTS.other).label;
  }

  /* ---------- 渲染 ---------- */
  function inner() {
    var box = el.messages.querySelector('.messages-inner');
    if (!box) {
      el.messages.innerHTML = '';
      box = document.createElement('div');
      box.className = 'messages-inner';
      el.messages.appendChild(box);
    }
    return box;
  }

  function renderEmpty() {
    el.messages.innerHTML =
      '<div class="empty-state">' +
      '<div class="big-avatar">哭</div>' +
      '<h2>你好，我是哭包</h2>' +
      '<p>我可以帮你处理退款售后、订单物流查询和技术故障排查。<br/>试试下面的问题，或直接描述你的情况。</p>' +
      '<div class="suggest">' +
      '<button data-suggest="我的订单 A2024001 到哪了？">查一下订单物流</button>' +
      '<button data-suggest="商品还没拆封，怎么申请退款？">怎么申请退款</button>' +
      '<button data-suggest="App 一打开就闪退，怎么办？">App 闪退怎么办</button>' +
      '<button data-suggest="支付失败，是不是扣了我两次钱？">支付失败处理</button>' +
      '</div></div>';
    Array.prototype.forEach.call(el.messages.querySelectorAll('[data-suggest]'), function (btn) {
      btn.addEventListener('click', function () { send(btn.getAttribute('data-suggest')); });
    });
  }

  function tagsHtml(msg) {
    var tags = [];
    if (msg.role === 'assistant' && msg.intent) {
      tags.push('<span class="msg-tag brand">意图 · ' + esc(intentLabel(msg.intent)) + '</span>');
    }
    var meta = msg.meta || {};
    if (meta.faqs && meta.faqs.length) {
      tags.push('<span class="msg-tag">FAQ 命中 ' + meta.faqs.length + ' 条</span>');
    }
    if (meta.order_no) {
      tags.push('<span class="msg-tag ok">已查订单 ' + esc(meta.order_no) + '</span>');
    }
    if (msg.role === 'agent') {
      var an = (msg.meta && msg.meta.agent_name) || '';
      tags.push('<span class="msg-tag ok">人工客服' + (an ? ' · ' + esc(an) : '') + '</span>');
    }
    return tags.length ? '<div class="msg-tags">' + tags.join('') + '</div>' : '';
  }

  function renderAppend(msg, record) {
    var box = inner();
    var node = document.createElement('div');

    if (msg.role === 'system') {
      node.className = 'msg system';
      node.innerHTML = '<div class="note">' + esc(msg.content) + '</div>';
      box.appendChild(node);
      scrollBottom();
      if (record !== false) state.messages.push(msg);
      return { root: node, bubble: node };
    }

    if (msg.role === 'user') {
      node.className = 'msg user';
      node.innerHTML = '<div class="bubble">' + rich(msg.content) + '</div>';
      box.appendChild(node);
      scrollBottom();
      if (record !== false) state.messages.push(msg);
      return { root: node, bubble: node.querySelector('.bubble') };
    }

    var isAgent = msg.role === 'agent';
    node.className = 'msg assistant';
    node.innerHTML =
      '<div class="msg-avatar' + (isAgent ? ' agent' : '') + '">' + (isAgent ? '客' : '哭') + '</div>' +
      '<div><div class="bubble"></div><div class="tags-slot"></div></div>';
    var bubble = node.querySelector('.bubble');
    bubble.innerHTML = msg.content ? rich(msg.content) : '';
    if (msg.content) {
      node.querySelector('.tags-slot').innerHTML = tagsHtml(msg);
    }
    box.appendChild(node);
    scrollBottom();
    if (record !== false) state.messages.push(msg);
    return { root: node, bubble: bubble, slot: node.querySelector('.tags-slot') };
  }

  function renderAll(items) {
    el.messages.innerHTML = '';
    if (!items || !items.length) { renderEmpty(); return; }
    state.messages = [];
    state.lastId = 0;
    var box = inner();
    box.innerHTML = '';
    items.forEach(function (m) {
      var msg = { id: m.id, role: m.role, content: m.content, intent: m.intent, meta: m.meta || {} };
      state.messages.push(msg);
      if (m.id > state.lastId) state.lastId = m.id;
      var node = document.createElement('div');
      if (m.role === 'system') {
        node.className = 'msg system';
        node.innerHTML = '<div class="note">' + esc(m.content) + '</div>';
      } else if (m.role === 'user') {
        node.className = 'msg user';
        node.innerHTML = '<div class="bubble">' + rich(m.content) + '</div>';
      } else {
        var isAgent = m.role === 'agent';
        node.className = 'msg assistant';
        node.innerHTML =
          '<div class="msg-avatar' + (isAgent ? ' agent' : '') + '">' + (isAgent ? '客' : '哭') + '</div>' +
          '<div><div class="bubble">' + rich(m.content) + '</div><div class="tags-slot">' + tagsHtml(msg) + '</div></div>';
      }
      box.appendChild(node);
    });
    scrollBottom();
  }

  function updateHeader() {
    var map = {
      active: { text: '在线 · 智能应答', color: '#0d9f6e' },
      handoff: { text: '人工客服接入中…', color: '#f59e0b' },
      closed: { text: '本次咨询已结束', color: '#94a3b8' },
    };
    var s = map[state.status] || map.active;
    el.statusText.textContent = s.text;
    el.statusDot.style.color = s.color;
  }

  function setIntentPill(intent) {
    if (!intent || intent === 'other') { el.intentPill.classList.add('hidden'); return; }
    el.intentPill.classList.remove('hidden');
    el.intentPill.textContent = '意图 · ' + intentLabel(intent);
  }

  function updateSummaryPill() {
    if (state.summary) el.summaryPill.classList.remove('hidden');
    else el.summaryPill.classList.add('hidden');
  }

  function isBusinessHours() {
    var h = (new Date().getUTCHours() + 8) % 24;
    return h >= 9 && h < 21;
  }

  var bannerCache = '';
  var waitTimer = null;
  var waitStart = 0;

  function startWaitTimer() {
    stopWaitTimer();
    waitStart = Date.now();
    paintWait();
    waitTimer = setInterval(paintWait, 1000);
  }
  function stopWaitTimer() {
    if (waitTimer) { clearInterval(waitTimer); waitTimer = null; }
  }
  function paintWait() {
    var node = document.getElementById('waitTimer');
    if (!node) { stopWaitTimer(); return; }
    var s = Math.floor((Date.now() - waitStart) / 1000);
    node.textContent = Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }

  function showBanner(force) {
    var key = 'h|' + (state.assigneeName || '') + '|' + (isBusinessHours() ? 'on' : 'off');
    if (!force && key === bannerCache && el.bannerWrap.firstChild) return;

    // 坐席已接入
    if (state.assigneeName) {
      bannerCache = key;
      stopWaitTimer();
      el.bannerWrap.innerHTML =
        '<div class="handoff-banner show">' +
        '<span class="dot" style="color:#0d9f6e"></span>' +
        '<span><b>' + esc(state.assigneeName) + ' 已接入</b>，正在为您处理，请稍候。</span></div>';
      scrollBottom();
      return;
    }

    if (isBusinessHours()) {
      bannerCache = key;
      el.bannerWrap.innerHTML =
        '<div class="handoff-banner show">' +
        '<span class="dot" style="color:#b45309"></span>' +
        '<span><b>已为您转接人工客服</b>，正在等待接入（已等待 <span class="wait-timer" id="waitTimer">0:00</span>）。</span>' +
        '<span class="spacer"></span></div>';
      if (!waitTimer) startWaitTimer();
      scrollBottom();
      return;
    }

    bannerCache = key;
    stopWaitTimer();
    el.bannerWrap.innerHTML =
      '<div class="handoff-banner show offline">' +
      '<div style="display:flex;gap:8px;align-items:flex-start;">' +
      '<span class="dot" style="color:#b45309;margin-top:7px;"></span>' +
      '<span><b>当前为非人工服务时间（9:00-21:00）</b>，您的问题已记录。留下手机号或邮箱，客服会在下个工作时段优先联系您。</span>' +
      '</div>' +
      '<div class="contact-row">' +
      '<input id="contactInput" maxlength="120" placeholder="手机号 / 邮箱（选填）" />' +
      '<button class="ghost-btn primary" id="contactBtn">提交</button>' +
      '</div></div>';
    var btn = document.getElementById('contactBtn');
    if (btn) btn.addEventListener('click', submitContact);
    scrollBottom();
  }

  async function submitContact() {
    var input = document.getElementById('contactInput');
    var val = input ? input.value.trim() : '';
    if (!val) { toast('请填写手机号或邮箱'); return; }
    var btn = document.getElementById('contactBtn');
    if (btn) btn.disabled = true;
    try {
      unwrap(
        await state.cloud.database.rpc('cs_guest_contact', {
          p_guest_key: guestKey,
          p_conversation_id: state.conversationId,
          p_contact: val,
        })
      );
      el.bannerWrap.innerHTML =
        '<div class="handoff-banner show">' +
        '<span class="dot" style="color:#0d9f6e"></span>' +
        '<span><b>联系方式已收到</b>，客服会在下个工作时段（9:00 起）优先联系您。</span></div>';
      var note = { role: 'system', content: '已留下联系方式，等待客服联系。', meta: { kind: 'contact' } };
      renderAppend(note);
      try { await saveMessage(note); } catch (e) { /* 忽略 */ }
      toast('提交成功');
    } catch (e) {
      if (btn) btn.disabled = false;
      toast(e.message || '提交失败');
    }
  }

  function hideBanner() {
    el.bannerWrap.innerHTML = '';
    bannerCache = '';
    stopWaitTimer();
  }

  function refreshConvList() {
    if (!state.conversations.length) {
      el.convList.innerHTML = '<div style="padding:14px 10px;color:#94a3b8;font-size:12.5px;">还没有对话记录</div>';
      return;
    }
    el.convList.innerHTML = state.conversations
      .map(function (c) {
        var dotColor = c.status === 'handoff' ? '#f59e0b' : c.status === 'closed' ? '#94a3b8' : '#0d9f6e';
        var title = c.intent ? intentLabel(c.intent) : '新对话';
        return (
          '<button class="conv-item' + (c.id === state.conversationId ? ' active' : '') + '" data-id="' + c.id + '">' +
          '<div class="row"><span class="dot" style="color:' + dotColor + '"></span>' +
          '<span class="title">' + esc(title) + '</span>' +
          '<span class="time">' + esc(timeStr(c.updated_at)) + '</span></div>' +
          '<div class="preview">' + esc(c.last_message || '（暂无消息）') + '</div>' +
          '</button>'
        );
      })
      .join('');
    Array.prototype.forEach.call(el.convList.querySelectorAll('.conv-item'), function (btn) {
      btn.addEventListener('click', function () {
        var id = Number(btn.getAttribute('data-id'));
        if (id !== state.conversationId) openConversation(id);
      });
    });
  }

  /* ---------- 数据 ---------- */
  async function loadFaqs() {
    var res = await state.cloud.database
      .from('cs_faqs')
      .select('id,question,answer,category,keywords,priority')
      .order('priority', { ascending: false });
    if (res.error) throw res.error;
    return res.data || [];
  }

  async function pickModel() {
    var models = await state.cloud.llm.models.list();
    if (!models || !models.length) return null;
    for (var i = 0; i < models.length; i += 1) {
      if (models[i].disabled !== true) return models[i];
    }
    return null;
  }

  async function refreshConversations() {
    var r = unwrap(await state.cloud.database.rpc('cs_guest_list', { p_guest_key: guestKey }));
    state.conversations = (r && r.items) || [];
    var current = null;
    state.conversations.forEach(function (c) { if (c.id === state.conversationId) current = c; });
    if (current) state.satisfaction = current.satisfaction;
    refreshConvList();
    return state.conversations;
  }

  async function saveMessage(msg) {
    var r = unwrap(
      await state.cloud.database.rpc('cs_guest_append', {
        p_guest_key: guestKey,
        p_conversation_id: state.conversationId,
        p_role: msg.role,
        p_content: msg.content,
        p_intent: msg.intent || null,
        p_meta: msg.meta || {},
      })
    );
    if (r && r.id) {
      msg.id = r.id;
      if (r.id > state.lastId) state.lastId = r.id;
    }
    return msg;
  }

  async function openConversation(id) {
    stopPolling();
    state.conversationId = id;
    el.ratingWrap.innerHTML = '';
    try {
      var r = unwrap(
        await state.cloud.database.rpc('cs_guest_poll', {
          p_guest_key: guestKey,
          p_conversation_id: id,
          p_after_id: 0,
        })
      );
      state.status = r.status || 'active';
      state.assigneeName = r.assignee_name || null;
      state.summary = r.summary || null;
      state.summaryUpto = Number(r.summary_upto_id) || 0;
      updateSummaryPill();
      renderAll(r.items || []);
      var last = null;
      state.conversations.forEach(function (c) { if (c.id === id) last = c; });
      state.satisfaction = last ? last.satisfaction : null;
      state.intent = last ? last.intent : null;
      setIntentPill(state.intent);
      updateHeader();
      refreshConvList();
      if (state.status === 'handoff') { showBanner(); startPolling(); }
      else { hideBanner(); }
      if (state.status === 'closed') maybeShowRating();
    } catch (e) {
      toast(e.message || '会话加载失败');
    }
  }

  async function createConversation() {
    var r = unwrap(
      await state.cloud.database.rpc('cs_guest_start', {
        p_guest_key: guestKey,
        p_user_label: state.label,
      })
    );
    state.conversationId = r.conversation_id;
    state.messages = [];
    state.lastId = 0;
    state.status = 'active';
    state.satisfaction = null;
    state.assigneeName = null;
    state.summary = null;
    state.summaryUpto = 0;
    updateSummaryPill();
    state.rated = false;
    state.lowConf = 0;
    el.ratingWrap.innerHTML = '';
    hideBanner();
    var p = unwrap(
      await state.cloud.database.rpc('cs_guest_poll', {
        p_guest_key: guestKey,
        p_conversation_id: state.conversationId,
        p_after_id: 0,
      })
    );
    renderAll(p.items || []);
    updateHeader();
    await refreshConversations();
  }

  async function newConversation() {
    stopPolling();
    var hasReal = state.messages.some(function (m) { return m.role === 'user'; });
    if (state.conversationId && !hasReal) {
      toast('当前已经是新对话');
      return;
    }
    try {
      await createConversation();
      toast('已开启新对话');
    } catch (e) {
      toast(e.message || '创建对话失败');
    }
  }

  /* ---------- 意图 ---------- */
  async function detectIntent(text) {
    var ruled = CS.detectByRules(text);
    if (ruled.score >= 0.6 || !state.model) return ruled;
    try {
      var out = '';
      for await (var chunk of state.cloud.llm.chat.completions.create({
        model: state.model.id,
        messages: [
          { role: 'system', content: '你是精确的意图分类器，只输出 JSON，不要输出任何其它内容。' },
          { role: 'user', content: CS.classifyPrompt(text) },
        ],
        stream: true,
        temperature: 0,
        response_format: { type: 'json_object' },
      })) {
        var d = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
        if (d && d.content) out += d.content;
      }
      var m = out.match(/\{[\s\S]*\}/);
      if (m) {
        var parsed = JSON.parse(m[0]);
        var allowed = ['refund', 'order', 'tech', 'other'];
        if (allowed.indexOf(parsed.intent) >= 0) {
          return {
            intent: parsed.intent,
            score: Number(parsed.confidence) || 0.7,
            source: 'llm',
            hits: [],
          };
        }
      }
    } catch (e) {
      /* 模型分类失败时沿用规则结果 */
    }
    return ruled;
  }

  /* ---------- 转人工 ---------- */
  function startPolling() {
    stopPolling();
    state.pollTimer = setInterval(pollOnce, 4000);
  }
  function stopPolling() {
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  }

  async function pollOnce() {
    if (!state.conversationId || state.streaming) return;
    try {
      var r = unwrap(
        await state.cloud.database.rpc('cs_guest_poll', {
          p_guest_key: guestKey,
          p_conversation_id: state.conversationId,
          p_after_id: state.lastId,
        })
      );
      if (!r || r.ok === false) return;
      if (r.assignee_name !== undefined) state.assigneeName = r.assignee_name;
      if (r.summary && r.summary !== state.summary) {
        state.summary = r.summary;
        state.summaryUpto = Number(r.summary_upto_id) || state.summaryUpto;
        updateSummaryPill();
      }
      if (r.status && r.status !== state.status) {
        state.status = r.status;
        updateHeader();
        if (r.status === 'closed') { hideBanner(); stopPolling(); maybeShowRating(); }
      }
      if (state.status === 'handoff') showBanner();
      (r.items || []).forEach(function (m) {
        if (m.id <= state.lastId) return;
        state.lastId = m.id;
        if (m.role !== 'user') {
          renderAppend({ id: m.id, role: m.role, content: m.content, intent: m.intent, meta: m.meta || {} });
        }
      });
    } catch (e) {
      /* 轮询失败静默重试 */
    }
  }

  async function doHandoff(reason) {
    try {
      unwrap(
        await state.cloud.database.rpc('cs_guest_update', {
          p_guest_key: guestKey,
          p_conversation_id: state.conversationId,
          p_status: 'handoff',
        })
      );
    } catch (e) { /* 状态更新失败不阻断提示 */ }

    state.status = 'handoff';
    state.assigneeName = null;
    var note = {
      role: 'system',
      content: '已转接人工客服（' + reason + '）。客服将在工作时间 9:00-21:00 尽快接入。',
      meta: { kind: 'handoff' },
    };
    renderAppend(note);
    try { await saveMessage(note); } catch (e) { /* 忽略 */ }
    updateHeader();
    showBanner();
    startPolling();
    refreshConversations().catch(function () {});
  }

  /* ---------- 评分 ---------- */
  function maybeShowRating() {
    if (state.rated || state.satisfaction) return;
    if (state.status !== 'closed') return;
    showRating();
  }

  function showRating() {
    if (el.ratingWrap.querySelector('.rating-card')) return;
    el.ratingWrap.innerHTML =
      '<div class="rating-card show">' +
      '<h4>这次的服务您还满意吗？</h4>' +
      '<p>您的评价会帮助我们持续改进服务质量</p>' +
      '<div class="stars">' +
      [1, 2, 3, 4, 5].map(function (n) { return '<button data-star="' + n + '" aria-label="' + n + ' 星">★</button>'; }).join('') +
      '</div>' +
      '<textarea id="ratingFeedback" placeholder="补充说明（选填）"></textarea>' +
      '<div class="rating-actions">' +
      '<button class="ghost-btn" id="ratingLater">稍后再说</button>' +
      '<button class="ghost-btn primary" id="ratingSubmit">提交评价</button>' +
      '</div></div>';

    var score = 0;
    var starBtns = el.ratingWrap.querySelectorAll('[data-star]');
    Array.prototype.forEach.call(starBtns, function (b) {
      b.addEventListener('click', function () {
        score = Number(b.getAttribute('data-star'));
        Array.prototype.forEach.call(starBtns, function (x) {
          x.classList.toggle('on', Number(x.getAttribute('data-star')) <= score);
        });
      });
    });
    el.ratingWrap.querySelector('#ratingLater').addEventListener('click', function () {
      el.ratingWrap.innerHTML = '';
    });
    el.ratingWrap.querySelector('#ratingSubmit').addEventListener('click', async function () {
      if (!score) { toast('请先选择星级'); return; }
      var fb = el.ratingWrap.querySelector('#ratingFeedback').value;
      try {
        unwrap(
          await state.cloud.database.rpc('cs_guest_rate', {
            p_guest_key: guestKey,
            p_conversation_id: state.conversationId,
            p_score: score,
            p_feedback: fb || null,
          })
        );
        state.rated = true;
        state.satisfaction = score;
        el.ratingWrap.innerHTML = '';
        renderAppend({ role: 'system', content: '感谢评价：' + score + ' 星', meta: { kind: 'rating' } });
        toast('感谢您的评价！');
        refreshConversations().catch(function () {});
      } catch (e) {
        toast(e.message || '评价提交失败');
      }
    });
  }

  /* ---------- 发送 ---------- */
  function setSending(on) {
    state.streaming = on;
    el.sendBtn.disabled = on;
    el.input.disabled = on;
    if (on) {
      el.stopWrap.innerHTML = '<button class="stop-btn" id="stopBtn"><span class="stop-icon"></span>停止生成</button>';
      var b = document.getElementById('stopBtn');
      if (b) b.addEventListener('click', stopStreaming);
    } else {
      el.stopWrap.innerHTML = '';
      el.input.focus();
    }
  }

  function stopStreaming() {
    if (state.controller) {
      try { state.controller.abort(); } catch (e) { /* 忽略 */ }
    }
  }

  function removeLastMessage(msg) {
    var box = el.messages.querySelector('.messages-inner');
    if (box && box.lastElementChild && box.lastElementChild.classList.contains('msg')) {
      box.removeChild(box.lastElementChild);
    }
    var idx = state.messages.indexOf(msg);
    if (idx >= 0) state.messages.splice(idx, 1);
  }

  /* 前端限流：1 秒最小间隔 + 每分钟 10 条（服务端另有每分钟 12 条的硬限制） */
  var RATE = { windowMs: 60000, max: 10, minGap: 1000 };
  function checkRate() {
    var now = Date.now();
    if (now - state.lastSendAt < RATE.minGap) return '发得太快啦，稍等一下再发';
    state.sendTimes = state.sendTimes.filter(function (t) { return now - t < RATE.windowMs; });
    if (state.sendTimes.length >= RATE.max) return '发送太频繁，请稍后再试（每分钟最多 ' + RATE.max + ' 条）';
    state.sendTimes.push(now);
    state.lastSendAt = now;
    return null;
  }

  async function streamFake(text, meta) {
    var msg = { role: 'assistant', content: text, intent: null, meta: meta || {} };
    renderAppend(msg);
    try { await saveMessage(msg); } catch (e) { /* 忽略 */ }
    return msg;
  }

  async function send(text) {
    var content = String(text || '').trim();
    if (!content || state.streaming || state.preview) return;
    if (!state.model) { toast('模型暂不可用，请稍后刷新页面'); return; }
    var blocked = checkRate();
    if (blocked) { toast(blocked); return; }
    if (state.status === 'closed') {
      toast('本次咨询已结束，已为您开启新对话');
      try { await createConversation(); } catch (e) { toast(e.message || '创建对话失败'); return; }
    }

    el.input.value = '';
    autoGrow();
    setSending(true);

    try {
      if (!state.conversationId) await createConversation();

      var history = buildHistory();

      // 先落地用户气泡，再做意图识别，避免接口等待期间界面无反馈
      var userMsg = { role: 'user', content: content, intent: null, meta: {} };
      renderAppend(userMsg);

      var det = await detectIntent(content);
      state.intent = det.intent;
      setIntentPill(det.intent);
      userMsg.intent = det.intent;

      // FAQ 检索前置：命中为空时打上 faq_miss 标记，供后台「知识缺口」统计
      var faqs = CS.retrieveFaq(content, state.faqs, 3);
      userMsg.meta = { score: det.score, source: det.source, faq_miss: faqs.length === 0 };

      try {
        await saveMessage(userMsg);
      } catch (e) {
        removeLastMessage(userMsg);
        el.input.value = content;
        autoGrow();
        toast(e.code === 'rate_limited' ? '发送太频繁，请稍后再试（每分钟最多 12 条）' : (e.message || '发送失败'));
        return;
      }

      try {
        unwrap(
          await state.cloud.database.rpc('cs_guest_update', {
            p_guest_key: guestKey,
            p_conversation_id: state.conversationId,
            p_intent: det.intent,
            p_intent_score: det.score,
          })
        );
      } catch (e) { /* 忽略 */ }

      // 明确要求人工：不调用模型，直接转接
      if (CS.isHumanRequest(content)) {
        await streamFake('好的，正在为您转接人工客服，请稍候…', { kind: 'handoff-notice' });
        await doHandoff('用户主动要求人工');
        setSending(false);
        return;
      }

      // 订单实时查询（FAQ 已在前面检索）
      var order = null;
      var orderNotFound = false;
      var orderNo = CS.extractOrderNo(content);
      if (orderNo) {
        try {
          order = unwrap(await state.cloud.database.rpc('cs_lookup_order', { p_order_no: orderNo }));
          if (!order) orderNotFound = true;
        } catch (e) { /* 查询失败按未查处理 */ }
      }

      var systemPrompt = CS.buildSystemPrompt({
        intent: det.intent,
        faqs: faqs,
        order: order,
        orderNotFound: orderNotFound,
        summary: state.summary,
      });

      var holder = renderAppend({ role: 'assistant', content: '', intent: det.intent, meta: {} }, false);
      holder.bubble.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';

      var full = '';
      var aborted = false;
      state.controller = new AbortController();

      try {
        for await (var chunk of state.cloud.llm.chat.completions.create({
          model: state.model.id,
          messages: [{ role: 'system', content: systemPrompt }].concat(history).concat([{ role: 'user', content: content }]),
          stream: true,
          temperature: 0.6,
          conversationId: 'cs-conv-' + state.conversationId,
          signal: state.controller.signal,
          stream_options: { include_usage: true },
        })) {
          var d = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
          if (d && d.content) {
            full += d.content;
            holder.bubble.innerHTML = rich(full);
            scrollBottom();
          }
        }
      } catch (err) {
        aborted = true;
        if (state.controller && state.controller.signal.aborted) {
          if (!full) {
            full = '（已停止生成）';
            holder.bubble.innerHTML = rich(full);
          }
          toast('已停止生成');
        } else {
          var msgText = llmErrorText(err);
          if (!full) {
            full = msgText;
            holder.bubble.innerHTML = rich(full);
          } else {
            holder.bubble.innerHTML = rich(full) + '<br><br>（生成中断：' + esc(msgText) + '）';
          }
        }
      }

      var assistantMsg = {
        role: 'assistant',
        content: full,
        intent: det.intent,
        meta: {
          kind: 'answer',
          faqs: faqs.map(function (f) { return { id: f.id, q: f.question }; }),
          order_no: order ? order.order_no : null,
          aborted: aborted,
        },
      };
      holder.slot.innerHTML = tagsHtml(assistantMsg);
      state.messages.push(assistantMsg);
      try { await saveMessage(assistantMsg); } catch (e) { /* 忽略 */ }

      // 自动转人工判定
      var auto = false;
      if (CS.isComplaint(content)) { auto = true; }
      if (det.intent === 'other' && det.score < 0.5) {
        state.lowConf += 1;
        if (state.lowConf >= 2) auto = true;
      } else {
        state.lowConf = 0;
      }
      if (auto && state.status === 'active') {
        await doHandoff(CS.isComplaint(content) ? '检测到投诉或强烈负面情绪' : '连续两轮未能识别用户诉求');
      }

      refreshConversations().catch(function () {});

      // 长会话：把较早的对话压缩成摘要，供后续轮次使用（不阻塞本轮回复）
      maybeSummarize();
    } catch (e) {
      toast(e.message || '发送失败，请重试');
    } finally {
      setSending(false);
    }
  }

  function llmErrorText(err) {
    var code = (err && err.error && err.error.code) || '';
    if (code.indexOf('quota_') === 0) return '当前模型的调用额度已用尽，请稍后再试。';
    if (code.indexOf('gateway_') === 0 || code.indexOf('model_') === 0) return '模型服务暂时不可用，请点击重新发送。';
    if (code.indexOf('auth_') === 0) return '云服务鉴权异常，请刷新页面后重试。';
    if (code.indexOf('request_') === 0) return '请求参数异常，请重试。';
    return '回复生成失败，请稍后重试。';
  }

  function buildHistory() {
    // 有摘要时只带最近 6 条，其余信息由摘要承载
    var limit = state.summary ? 6 : 10;
    return state.messages
      .filter(function (m) {
        return (m.role === 'user' || m.role === 'assistant' || m.role === 'agent') && m.content;
      })
      .slice(-limit)
      .map(function (m) {
        return {
          role: m.role === 'user' ? 'user' : 'assistant',
          content: m.role === 'agent' ? '[人工客服] ' + m.content : m.content,
        };
      });
  }

  /* ---------- 长会话摘要 ---------- */
  var SUMMARY_AFTER = 12;   // 有效消息超过这个条数后开始摘要
  var SUMMARY_STEP = 6;     // 之后每新增这么多条重新摘要一次

  async function maybeSummarize() {
    if (state.summarizing || state.streaming) return;
    if (!state.model || !state.conversationId) return;
    if (state.status === 'closed') return;

    var msgs = state.messages.filter(function (m) {
      return (m.role === 'user' || m.role === 'assistant' || m.role === 'agent') && m.content;
    });
    if (msgs.length < SUMMARY_AFTER) return;
    if (state.lastId - (state.summaryUpto || 0) < SUMMARY_STEP) return;

    state.summarizing = true;
    try {
      var transcript = msgs
        .slice(-30)
        .map(function (m) {
          var who = m.role === 'user' ? '用户' : (m.role === 'agent' ? '人工客服' : '客服');
          return who + '：' + String(m.content).replace(/\s+/g, ' ').slice(0, 300);
        })
        .join('\n');

      var out = '';
      for await (var chunk of state.cloud.llm.chat.completions.create({
        model: state.model.id,
        messages: [
          {
            role: 'system',
            content:
              '你是会话摘要助手。把客服对话压缩成不超过 200 字的中文摘要，只保留：用户核心诉求、涉及的订单号、已给出的结论或承诺、尚未解决的问题。不加入对话里没有的信息，不做评价，直接输出摘要正文。',
          },
          { role: 'user', content: transcript },
        ],
        stream: true,
        temperature: 0.3,
      })) {
        var d = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
        if (d && d.content) out += d.content;
      }
      out = out.trim();
      if (!out) return;

      var r = unwrap(
        await state.cloud.database.rpc('cs_guest_summary_save', {
          p_guest_key: guestKey,
          p_conversation_id: state.conversationId,
          p_summary: out,
          p_upto_id: state.lastId,
        })
      );
      if (r && r.ok !== false) {
        state.summary = out;
        state.summaryUpto = state.lastId;
        updateSummaryPill();
      }
    } catch (e) {
      /* 摘要失败不影响对话主流程 */
    } finally {
      state.summarizing = false;
    }
  }

  /* ---------- 输入框 ---------- */
  function autoGrow() {
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(el.input.scrollHeight, 132) + 'px';
  }

  /* ---------- 结束咨询 ---------- */
  async function endConversation() {
    if (!state.conversationId) { toast('还没有进行中的对话'); return; }
    if (state.status === 'closed') { toast('本次咨询已结束'); return; }
    try {
      unwrap(
        await state.cloud.database.rpc('cs_guest_update', {
          p_guest_key: guestKey,
          p_conversation_id: state.conversationId,
          p_status: 'closed',
        })
      );
      state.status = 'closed';
      updateHeader();
      stopPolling();
      hideBanner();
      var note = { role: 'system', content: '本次咨询已结束。', meta: { kind: 'closed' } };
      renderAppend(note);
      try { await saveMessage(note); } catch (e) { /* 忽略 */ }
      showRating();
      refreshConversations().catch(function () {});
    } catch (e) {
      toast(e.message || '操作失败');
    }
  }

  /* ---------- 启动 ---------- */
  function bind() {
    el.sendBtn.addEventListener('click', function () { send(el.input.value); });
    el.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send(el.input.value);
      }
    });
    el.input.addEventListener('input', autoGrow);
    el.newChatBtn.addEventListener('click', newConversation);
    el.endBtn.addEventListener('click', endConversation);
  }

  /* ---------- 静态预览模式（GitHub Pages）----------
   * 阶段7：模式由 assets/runtime.js 显式声明（window.__CS_MODE__），
   * 兼容历史行为：没有声明时仍按 *.github.io 判断。
   * 静态版不发起任何云端请求，避免满屏报错。 */
  function isStaticPreview() {
    if (typeof window.isStaticMode === 'function') return window.isStaticMode();
    return /\.github\.io$/i.test(location.hostname);
  }

  function enterPreviewMode() {
    state.preview = true;
    el.modelHint.textContent = '静态预览模式 · 不连接云端';
    el.input.disabled = true;
    el.input.placeholder = '当前为静态预览版，对话功能需在服务器部署版本中使用';
    el.sendBtn.disabled = true;
    el.bannerWrap.innerHTML =
      '<div class="handoff-banner show" style="max-width:780px;margin:0 auto 8px;">' +
      '<span class="dot" style="color:#b45309"></span>' +
      '<span><b>静态预览模式</b>：本页面只展示界面，数据读写与智能应答需在服务器部署版本中使用。</span></div>';
    el.messages.innerHTML =
      '<div class="empty-state">' +
      '<div class="big-avatar">哭</div>' +
      '<h2>你好，我是哭包</h2>' +
      '<p>当前是 GitHub Pages 静态预览版，<b>不连接云端</b>，所以对话、历史记录与后台都不可用。<br/>' +
      '完整功能请访问服务器部署版本。</p>' +
      '<div class="suggest">' +
      '<button data-noop="1">查订单物流</button>' +
      '<button data-noop="1">怎么申请退款</button>' +
      '<button data-noop="1">App 闪退怎么办</button>' +
      '</div></div>';
    Array.prototype.forEach.call(el.messages.querySelectorAll('[data-noop]'), function (btn) {
      btn.addEventListener('click', function () {
        toast('静态预览模式：请在服务器部署版本中体验完整功能');
      });
    });
  }

  async function boot() {
    el.guestLabel.textContent = state.label;
    bind();

    if (isStaticPreview()) {
      enterPreviewMode();
      return;
    }

    renderEmpty();

    try {
      state.cloud = window.createCsCloud();
    } catch (e) {
      el.messages.innerHTML =
        '<div class="empty-state"><h2>初始化失败</h2><p>' + esc(e.message || '云服务不可用') + '</p></div>';
      return;
    }

    try {
      state.faqs = await loadFaqs();
    } catch (e) {
      toast('FAQ 知识库加载失败，回答可能不够准确');
    }

    try {
      state.model = await pickModel();
      el.modelHint.textContent = state.model ? '模型：' + (state.model.name || state.model.id) : '模型暂不可用';
      if (!state.model) toast('模型暂不可用，暂时无法智能回复');
    } catch (e) {
      el.modelHint.textContent = '模型加载失败';
    }

    try {
      var list = await refreshConversations();
      if (list.length) await openConversation(list[0].id);
    } catch (e) {
      toast(e.message || '历史会话加载失败');
    }
  }

  boot();
})();
