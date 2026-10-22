/* 哭包 · 管理后台逻辑 */
(function () {
  'use strict';

  var unwrap = window.unwrapRpc;
  var $ = function (id) { return document.getElementById(id); };
  var CODE_KEY = 'cs_admin_code_v1';

  var INTENT_LABEL = { refund: '退款', order: '查询订单', tech: '技术支持', other: '其他' };

  var state = {
    cloud: null,
    code: null,
    role: 'admin',
    agentName: '',
    agentId: 0,
    stats: null,
    tab: 'overview',
    status: 'all',
    page: 0,
    pageSize: 20,
    total: 0,
    items: [],
    detailId: null,
    detailMode: 'admin',
    timer: null,
  };

  /* ---------- 通用 ---------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }
  function timeStr(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    var p = function (n) { return ('0' + n).slice(-2); };
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function statusPill(status) {
    if (status === 'handoff') return '<span class="pill warn"><span class="dot"></span>待人工</span>';
    if (status === 'closed') return '<span class="pill muted"><span class="dot"></span>已结束</span>';
    return '<span class="pill ok"><span class="dot"></span>进行中</span>';
  }
  function scoreCell(v) {
    if (v == null) return '<span class="score-cell"><span class="na">未评价</span></span>';
    return '<span class="score-cell"><span class="star">★</span>' + v + '</span>';
  }

  function handleAuthError(e) {
    if (e && (e.code === 'unauthorized' || /口令/.test(e.message || ''))) {
      logout();
      return true;
    }
    return false;
  }

  /* ---------- 登录 ---------- */
  async function verifyCode(code) {
    return unwrap(await state.cloud.database.rpc('cs_console_login', { p_code: code }));
  }

  function applyRole() {
    var adminOnly = ['overview', 'conversations', 'faq', 'gaps'];
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      var isAdminTab = adminOnly.indexOf(t.getAttribute('data-tab')) >= 0;
      t.style.display = (state.role === 'agent' && isAdminTab) ? 'none' : '';
    });
  }

  function enter(login) {
    state.role = login.is_admin ? 'admin' : 'agent';
    state.agentName = login.name;
    state.agentId = login.agent_id;
    $('whoami').textContent = login.name + (login.is_admin ? ' · 管理员' : ' · 客服');
    $('gate').classList.add('hidden');
    $('console').classList.remove('hidden');
    applyRole();
    if (state.role === 'admin') {
      loadStats();
      loadConversations();
    }
    switchTab(state.role === 'admin' ? 'overview' : 'queue');
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(function () {
      if (state.detailId) return;
      if (state.tab === 'queue') loadQueue(true);
      else if (state.tab === 'conversations') loadConversations(true);
    }, 10000);
    toast('欢迎，' + login.name);
  }

  function logout() {
    state.code = null;
    state.role = 'admin';
    try { sessionStorage.removeItem(CODE_KEY); } catch (e) { /* 忽略 */ }
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    $('console').classList.add('hidden');
    $('gate').classList.remove('hidden');
    $('codeInput').value = '';
    closeDrawer();
  }

  /* ---------- 工单队列 ---------- */
  function fmtWait(sec) {
    var s = Math.max(0, Number(sec) || 0);
    var m = Math.floor(s / 60);
    if (m < 1) return s + ' 秒';
    if (m < 60) return m + ' 分钟';
    return Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分';
  }
  function waitClass(sec) {
    var s = Number(sec) || 0;
    if (s >= 600) return ' danger';
    if (s >= 180) return ' warn';
    return '';
  }

  async function loadQueue(silent) {
    try {
      var r = unwrap(await state.cloud.database.rpc('cs_agent_queue', { p_code: state.code }));
      renderQueue(r);
    } catch (e) {
      if (!handleAuthError(e) && !silent) toast(e.message || '工单队列加载失败');
    }
  }

  function qrow(x, kind) {
    var overdue = Number(x.wait_seconds) >= 180;
    var actions = '';
    if (kind === 'wait') {
      actions = '<button class="ghost-btn primary" data-act="claim" data-id="' + x.id + '">接入</button>';
    } else if (kind === 'mine') {
      actions = '<button class="ghost-btn" data-act="open" data-id="' + x.id + '">处理</button>';
    } else {
      actions = '<button class="ghost-btn" data-act="open" data-id="' + x.id + '">查看</button>';
    }
    return (
      '<div class="qrow' + (kind === 'wait' && overdue ? ' overdue' : '') + '">' +
      '<span class="qid">#' + x.id + '</span>' +
      '<div class="qmain"><div class="line1">' +
      '<span class="who">' + esc(x.user_label || '访客') + '</span>' +
      '<span class="tag-mini">' + esc(INTENT_LABEL[x.intent] || '待识别') + '</span>' +
      (kind === 'other' ? '<span class="tag-mini">' + esc(x.assignee_name || '其他客服') + '</span>' : '') +
      (x.contact ? '<span class="tag-mini">已留联系方式</span>' : '') +
      '</div><div class="last">' + esc(x.last_message || '（暂无消息）') + '</div></div>' +
      '<span class="qwait' + waitClass(x.wait_seconds) + '">' +
      (kind === 'other' ? '处理中 ' : '已等待 ') + fmtWait(x.wait_seconds) + '</span>' +
      '<div class="qactions">' + actions + '</div></div>'
    );
  }

  function bindQueueActions() {
    Array.prototype.forEach.call(document.querySelectorAll('#tab-queue [data-act]'), function (b) {
      b.addEventListener('click', function () {
        var id = Number(b.getAttribute('data-id'));
        if (b.getAttribute('data-act') === 'claim') claimConversation(id);
        else openDetail(id, 'agent');
      });
    });
  }

  function renderQueue(r) {
    var waiting = r.waiting || [];
    var mine = r.mine || [];
    var others = r.others || [];
    var overdue = waiting.filter(function (x) { return Number(x.wait_seconds) >= 180; }).length;
    $('qWaiting').textContent = waiting.length;
    $('qMine').textContent = mine.length;
    $('qOverdue').textContent = overdue;
    $('qResolved').textContent = r.resolved_today || 0;

    $('queueList').innerHTML = waiting.length
      ? waiting.map(function (x) { return qrow(x, 'wait'); }).join('')
      : '<div class="qempty">暂时没有待接入的工单</div>';
    $('mineList').innerHTML = mine.length
      ? mine.map(function (x) { return qrow(x, 'mine'); }).join('')
      : '<div class="qempty">你还没有接入中的工单</div>';
    $('othersList').innerHTML = others.length
      ? others.map(function (x) { return qrow(x, 'other'); }).join('')
      : '<div class="qempty">没有其他坐席正在处理的工单</div>';
    bindQueueActions();
  }

  async function claimConversation(id) {
    try {
      unwrap(await state.cloud.database.rpc('cs_agent_claim', { p_code: state.code, p_conversation_id: id }));
      toast('已接入 #' + id);
      await loadQueue(true);
      await openDetail(id, 'agent');
    } catch (e) {
      if (!handleAuthError(e)) toast(e.message || '接入失败');
      loadQueue(true);
    }
  }

  /* ---------- 统计 ---------- */
  function renderStats(s) {
    state.stats = s;
    var kpis = [
      {
        label: '累计会话',
        value: s.total_conversations,
        foot: '今日新增 ' + s.today_conversations + ' 条',
        cls: '',
      },
      { label: '累计消息', value: s.total_messages, foot: '含用户、AI 与人工消息', cls: '' },
      {
        label: '平均满意度',
        value: (s.avg_score || 0) + '<small>/ 5</small>',
        foot: '基于 ' + s.rated_count + ' 条评价',
        cls: '',
      },
      { label: '好评率', value: (s.satisfied_rate || 0) + '<small>%</small>', foot: '4 星及以上占比', cls: '' },
      {
        label: '待人工处理',
        value: s.pending_handoff,
        foot: '累计转人工 ' + s.handoff_count + ' 次',
        cls: 'accent',
      },
    ];
    $('kpiGrid').innerHTML = kpis
      .map(function (k) {
        return (
          '<div class="kpi ' + k.cls + '">' +
          '<div class="label">' + k.label + '</div>' +
          '<div class="value">' + k.value + '</div>' +
          '<div class="foot">' + k.foot + '</div>' +
          '</div>'
        );
      })
      .join('');

    // 满意度分布
    var dist = s.score_dist || {};
    var rated = Number(s.rated_count) || 0;
    var rows = '';
    for (var i = 5; i >= 1; i -= 1) {
      var cnt = Number(dist[String(i)] || 0);
      var pct = rated ? Math.round((cnt / rated) * 100) : 0;
      rows +=
        '<div class="bar-row"><span class="k">' + i + ' 星</span>' +
        '<span class="bar-track"><span class="bar-fill' + (i >= 4 ? ' ok' : i === 3 ? ' warn' : ' muted') + '" style="width:' + pct + '%"></span></span>' +
        '<span class="v">' + cnt + '</span></div>';
    }
    if (!rated) rows = '<div class="drawer-empty">还没有用户提交评价</div>';
    $('scoreDist').innerHTML = rows;

    // 意图分布
    var intents = s.intent_counts || [];
    var totalIntent = intents.reduce(function (a, b) { return a + Number(b.count); }, 0);
    var iRows = '';
    var palette = { refund: '', order: ' ok', tech: ' warn', other: ' muted' };
    intents.forEach(function (it) {
      var pct = totalIntent ? Math.round((Number(it.count) / totalIntent) * 100) : 0;
      iRows +=
        '<div class="bar-row"><span class="k">' + esc(INTENT_LABEL[it.intent] || it.intent) + '</span>' +
        '<span class="bar-track"><span class="bar-fill' + (palette[it.intent] || '') + '" style="width:' + pct + '%"></span></span>' +
        '<span class="v">' + it.count + '</span></div>';
    });
    if (!intents.length) iRows = '<div class="drawer-empty">暂无数据</div>';
    $('intentDist').innerHTML = iRows;

    // 近 14 天趋势
    var daily = s.daily || [];
    var max = 1;
    daily.forEach(function (d) { if (Number(d.conversations) > max) max = Number(d.conversations); });
    var bars = '';
    var labels = '';
    daily.forEach(function (d) {
      var pct = Math.round((Number(d.conversations) / max) * 100);
      bars +=
        '<div class="tbar" title="' + esc(d.day) + '｜会话 ' + d.conversations + '｜均分 ' + (d.avg_score || 0) + '">' +
        '<div class="tfill' + (Number(d.conversations) ? '' : ' zero') + '" style="height:' + Math.max(pct, 3) + '%"></div></div>';
      labels += '<span>' + esc(String(d.day).slice(5)) + '</span>';
    });
    $('trendChart').innerHTML =
      '<div class="tchart">' + bars + '</div><div class="tlabels">' + labels + '</div>';
  }

  async function loadStats() {
    try {
      var s = unwrap(await state.cloud.database.rpc('cs_admin_stats', { p_code: state.code }));
      renderStats(s);
    } catch (e) {
      if (!handleAuthError(e)) toast(e.message || '统计数据加载失败');
    }
  }

  /* ---------- 对话列表 ---------- */
  async function loadConversations(silent) {
    try {
      var r = unwrap(
        await state.cloud.database.rpc('cs_admin_conversations', {
          p_code: state.code,
          p_status: state.status,
          p_limit: state.pageSize,
          p_offset: state.page * state.pageSize,
        })
      );
      state.items = r.items || [];
      state.total = Number(r.total) || 0;
      renderTable();
    } catch (e) {
      if (!handleAuthError(e) && !silent) toast(e.message || '对话记录加载失败');
    }
  }

  function renderTable() {
    var body = $('convBody');
    if (!state.items.length) {
      body.innerHTML = '<tr><td colspan="8"><div class="empty-row">暂无对话记录</div></td></tr>';
    } else {
      body.innerHTML = state.items
        .map(function (c) {
          return (
            '<tr data-id="' + c.id + '"' + (c.id === state.detailId ? ' class="selected"' : '') + '>' +
            '<td class="cell-id">#' + c.id + '</td>' +
            '<td>' + esc(c.user_label || c.guest_key_mask || '访客') + '</td>' +
            '<td><span class="tag-mini">' + esc(INTENT_LABEL[c.intent] || '待识别') + '</span></td>' +
            '<td>' + statusPill(c.status) + '</td>' +
            '<td>' + scoreCell(c.satisfaction) + '</td>' +
            '<td class="cell-id">' + (c.message_count || 0) + '</td>' +
            '<td><div class="cell-preview">' + esc(c.last_message || '—') + '</div></td>' +
            '<td class="cell-id">' + timeStr(c.updated_at) + '</td>' +
            '</tr>'
          );
        })
        .join('');
      Array.prototype.forEach.call(body.querySelectorAll('tr'), function (tr) {
        tr.addEventListener('click', function () {
          openDetail(Number(tr.getAttribute('data-id')));
        });
      });
    }

    var from = state.total ? state.page * state.pageSize + 1 : 0;
    var to = Math.min((state.page + 1) * state.pageSize, state.total);
    $('pager').innerHTML =
      '<span>共 ' + state.total + ' 条，当前 ' + from + '-' + to + '</span>' +
      '<span style="display:flex;gap:8px;">' +
      '<button id="prevBtn"' + (state.page === 0 ? ' disabled' : '') + '>上一页</button>' +
      '<button id="nextBtn"' + (to >= state.total ? ' disabled' : '') + '>下一页</button></span>';
    var prev = $('prevBtn');
    var next = $('nextBtn');
    if (prev) prev.addEventListener('click', function () { if (state.page > 0) { state.page -= 1; loadConversations(); } });
    if (next) next.addEventListener('click', function () { if (to < state.total) { state.page += 1; loadConversations(); } });
  }

  /* ---------- 详情 ---------- */
  async function openDetail(id, mode) {
    state.detailId = id;
    state.detailMode = mode === 'agent' ? 'agent' : 'admin';
    $('mask').classList.add('show');
    $('drawer').classList.add('show');
    $('drawerTitle').textContent = '会话 #' + id;
    $('drawerSub').textContent = '加载中…';
    $('drawerBody').innerHTML = '<div class="drawer-empty">加载中…</div>';
    $('replyInput').value = '';
    $('releaseBtn').style.display = state.detailMode === 'agent' ? '' : 'none';
    renderTable();
    await loadDetail();
  }

  async function loadDetail() {
    if (!state.detailId) return;
    var fn = state.detailMode === 'agent' ? 'cs_agent_messages' : 'cs_admin_messages';
    try {
      var r = unwrap(
        await state.cloud.database.rpc(fn, {
          p_code: state.code,
          p_conversation_id: state.detailId,
        })
      );
      var conv = r.conversation || {};
      $('drawerSub').innerHTML =
        esc(conv.user_label || '访客') +
        ' · ' + esc(INTENT_LABEL[conv.intent] || '待识别') +
        ' · ' + (conv.satisfaction ? '满意度 ' + conv.satisfaction + ' 星' : '未评价') +
        (conv.assignee_name ? ' · 处理人 ' + esc(conv.assignee_name) : ' · 未分配') +
        ' · ' + esc(timeStr(conv.created_at));
      var html = (r.items || [])
        .map(function (m) {
          var who =
            m.role === 'user' ? '用户' :
            m.role === 'agent' ? ('人工客服' + (m.meta && m.meta.agent_name ? ' · ' + m.meta.agent_name : '')) :
            m.role === 'system' ? '系统' : 'AI 客服';
          var cls = m.role === 'user' ? 'user' : m.role === 'agent' ? 'agent' : m.role === 'system' ? 'system' : '';
          return (
            '<div class="dmsg ' + cls + '">' +
            '<div class="who">' + esc(who) + '<span>' + esc(timeStr(m.created_at)) + '</span>' +
            (m.intent ? '<span class="tag-mini">' + esc(INTENT_LABEL[m.intent] || m.intent) + '</span>' : '') +
            '</div><div class="text">' + esc(m.content) + '</div></div>'
          );
        })
        .join('');
      if (conv.contact) {
        html += '<div class="dmsg system"><div class="who">用户留的联系方式</div><div class="text">' + esc(conv.contact) + '</div></div>';
      }
      if (conv.feedback) {
        html += '<div class="dmsg system"><div class="who">用户评价留言</div><div class="text">' + esc(conv.feedback) + '</div></div>';
      }
      var head = conv.summary
        ? '<div class="dmsg summary-block"><div class="who">会话摘要 · 较早对话已压缩</div><div class="text">' + esc(conv.summary) + '</div></div>'
        : '';
      $('drawerBody').innerHTML = head + (html || (head ? '' : '<div class="drawer-empty">该会话还没有消息</div>'));
      $('drawerBody').scrollTop = $('drawerBody').scrollHeight;
    } catch (e) {
      if (!handleAuthError(e)) toast(e.message || '会话详情加载失败');
    }
  }

  function closeDrawer() {
    state.detailId = null;
    $('mask').classList.remove('show');
    $('drawer').classList.remove('show');
    renderTable();
  }

  /* ---------- 动作 ---------- */
  async function sendReply() {
    var btn = $('replyBtn');
    var val = $('replyInput').value.trim();
    if (!val) { toast('请输入回复内容'); return; }
    if (!state.detailId) return;
    btn.disabled = true;
    var fn = state.detailMode === 'agent' ? 'cs_agent_reply' : 'cs_admin_reply';
    try {
      unwrap(
        await state.cloud.database.rpc(fn, {
          p_code: state.code,
          p_conversation_id: state.detailId,
          p_content: val,
        })
      );
      $('replyInput').value = '';
      toast('已发送，用户端将在数秒内收到');
      await loadDetail();
      if (state.detailMode === 'agent') await loadQueue(true);
      else { await loadConversations(true); await loadStats(); }
    } catch (e) {
      if (!handleAuthError(e)) toast(e.message || '发送失败');
    } finally {
      btn.disabled = false;
    }
  }

  async function resolve() {
    if (!state.detailId) return;
    var isAgent = state.detailMode === 'agent';
    try {
      var args = { p_code: state.code, p_conversation_id: state.detailId };
      if (!isAgent) args.p_resolved = true;
      unwrap(await state.cloud.database.rpc(isAgent ? 'cs_agent_resolve' : 'cs_admin_resolve', args));
      toast('已标记为解决');
      await loadDetail();
      if (isAgent) await loadQueue(true);
      else { await loadConversations(true); await loadStats(); }
    } catch (e) {
      if (!handleAuthError(e)) toast(e.message || '操作失败');
    }
  }

  async function releaseTicket() {
    if (!state.detailId) return;
    try {
      unwrap(await state.cloud.database.rpc('cs_agent_release', { p_code: state.code, p_conversation_id: state.detailId }));
      toast('已释放，工单回到待接入队列');
      closeDrawer();
      await loadQueue(true);
    } catch (e) {
      if (!handleAuthError(e)) toast(e.message || '释放失败');
    }
  }

  /* ---------- 知识库 ---------- */
  var faqState = { items: [], editingId: null };

  async function loadFaqs() {
    try {
      var r = unwrap(await state.cloud.database.rpc('cs_admin_faq_list', { p_code: state.code }));
      faqState.items = r.items || [];
      renderFaqs();
    } catch (e) {
      if (!handleAuthError(e)) toast(e.message || '知识库加载失败');
    }
  }

  function renderFaqs() {
    var body = $('faqBody');
    if (!faqState.items.length) {
      body.innerHTML = '<tr><td colspan="7"><div class="empty-row">知识库还是空的</div></td></tr>';
      return;
    }
    body.innerHTML = faqState.items
      .map(function (f) {
        return (
          '<tr data-id="' + f.id + '">' +
          '<td class="cell-id">#' + f.id + '</td>' +
          '<td><span class="tag-mini">' + esc(INTENT_LABEL[f.category] || f.category) + '</span></td>' +
          '<td><div class="cell-preview" style="max-width:380px;">' + esc(f.question) + '</div></td>' +
          '<td><div class="cell-preview" style="max-width:190px;font-size:12px;">' + esc(f.keywords || '—') + '</div></td>' +
          '<td class="cell-id">' + (f.priority || 0) + '</td>' +
          '<td>' + (f.enabled
            ? '<span class="pill ok"><span class="dot"></span>启用</span>'
            : '<span class="pill muted"><span class="dot"></span>停用</span>') + '</td>' +
          '<td><button class="link-btn" data-act="edit" data-id="' + f.id + '">编辑</button>' +
          '<button class="link-btn danger" data-act="del" data-id="' + f.id + '">删除</button></td>' +
          '</tr>'
        );
      })
      .join('');

    Array.prototype.forEach.call(body.querySelectorAll('[data-act]'), function (b) {
      b.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var id = Number(b.getAttribute('data-id'));
        if (b.getAttribute('data-act') === 'edit') startEditFaq(id);
        else removeFaq(id);
      });
    });
  }

  function startEditFaq(id) {
    var f = null;
    faqState.items.forEach(function (x) { if (x.id === id) f = x; });
    if (!f) return;
    faqState.editingId = id;
    $('faqFormTitle').textContent = '编辑 FAQ #' + id;
    $('faqQuestion').value = f.question || '';
    $('faqAnswer').value = f.answer || '';
    $('faqCategory').value = f.category || 'general';
    $('faqKeywords').value = f.keywords || '';
    $('faqPriority').value = f.priority == null ? 5 : f.priority;
    $('faqEnabled').value = f.enabled ? 'true' : 'false';
    window.scrollTo({ top: 0, behavior: 'smooth' });
    $('faqQuestion').focus();
  }

  function resetFaqForm() {
    faqState.editingId = null;
    $('faqFormTitle').textContent = '新增 FAQ';
    $('faqQuestion').value = '';
    $('faqAnswer').value = '';
    $('faqCategory').value = 'general';
    $('faqKeywords').value = '';
    $('faqPriority').value = 5;
    $('faqEnabled').value = 'true';
  }

  async function saveFaq() {
    var btn = $('faqSave');
    var question = $('faqQuestion').value.trim();
    var answer = $('faqAnswer').value.trim();
    if (!question || !answer) { toast('问题和答案都要填'); return; }
    btn.disabled = true;
    try {
      unwrap(
        await state.cloud.database.rpc('cs_admin_faq_save', {
          p_code: state.code,
          p_question: question,
          p_answer: answer,
          p_id: faqState.editingId,
          p_category: $('faqCategory').value,
          p_keywords: $('faqKeywords').value.trim(),
          p_priority: Number($('faqPriority').value) || 0,
          p_enabled: $('faqEnabled').value === 'true',
        })
      );
      toast(faqState.editingId ? '已更新' : '已新增');
      resetFaqForm();
      await loadFaqs();
    } catch (e) {
      if (!handleAuthError(e)) toast(e.message || '保存失败');
    } finally {
      btn.disabled = false;
    }
  }

  async function removeFaq(id) {
    var f = null;
    faqState.items.forEach(function (x) { if (x.id === id) f = x; });
    if (!f) return;
    if (!window.confirm('确定删除这条 FAQ？\n\n' + f.question)) return;
    try {
      unwrap(await state.cloud.database.rpc('cs_admin_faq_delete', { p_code: state.code, p_id: id }));
      toast('已删除');
      if (faqState.editingId === id) resetFaqForm();
      await loadFaqs();
    } catch (e) {
      if (!handleAuthError(e)) toast(e.message || '删除失败');
    }
  }

  /* ---------- 知识缺口 ---------- */
  async function loadGaps() {
    var box = $('gapList');
    box.innerHTML = '<div class="drawer-empty">加载中…</div>';
    try {
      var r = unwrap(await state.cloud.database.rpc('cs_admin_gaps', { p_code: state.code, p_days: 30 }));
      var items = r.items || [];
      if (!items.length) {
        box.innerHTML = '<div class="drawer-empty">最近 30 天没有未命中的提问，知识库覆盖得不错</div>';
        return;
      }
      box.innerHTML = items
        .map(function (g) {
          return (
            '<div class="gap-row">' +
            '<span class="gap-badge' + (Number(g.cnt) > 1 ? '' : ' low') + '">' + g.cnt + '</span>' +
            '<div class="gap-q">' + esc(g.question) + '</div>' +
            '<span class="gap-meta">' + esc(INTENT_LABEL[g.intent] || '待识别') + ' · ' + esc(timeStr(g.last_seen)) + '</span>' +
            '<button class="link-btn" data-q="' + esc(g.question) + '" data-intent="' + esc(g.intent || '') + '">转为 FAQ</button>' +
            '</div>'
          );
        })
        .join('');
      Array.prototype.forEach.call(box.querySelectorAll('[data-q]'), function (b) {
        b.addEventListener('click', function () {
          gapToFaq(b.getAttribute('data-q'), b.getAttribute('data-intent'));
        });
      });
    } catch (e) {
      if (handleAuthError(e)) return;
      box.innerHTML = '<div class="drawer-empty">' + esc(e.message || '加载失败') + '</div>';
    }
  }

  function gapToFaq(question, intent) {
    switchTab('faq');
    setTimeout(function () {
      resetFaqForm();
      $('faqFormTitle').textContent = '新增 FAQ（来自知识缺口）';
      $('faqQuestion').value = question;
      $('faqCategory').value = (intent === 'refund' || intent === 'order' || intent === 'tech') ? intent : 'general';
      $('faqAnswer').focus();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }, 40);
  }

  /* ---------- 导出 CSV ---------- */
  function csvCell(v) {
    return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  }

  async function exportCsv() {
    var btn = $('exportBtn');
    btn.disabled = true;
    try {
      var r = unwrap(await state.cloud.database.rpc('cs_admin_export', { p_code: state.code, p_status: state.status }));
      var rows = r.items || [];
      if (!rows.length) { toast('当前筛选下没有可导出的记录'); return; }
      var head = ['会话ID', '访客', '会话状态', '会话意图', '满意度', '评价留言', '联系方式', '消息ID', '角色', '消息意图', '内容', '时间'];
      var lines = [head.map(csvCell).join(',')];
      rows.forEach(function (x) {
        lines.push([
          x.conversation_id, x.user_label, x.status, INTENT_LABEL[x.conv_intent] || '',
          x.satisfaction || '', x.feedback || '', x.contact || '',
          x.id, x.role, INTENT_LABEL[x.intent] || '', x.content, x.created_at,
        ].map(csvCell).join(','));
      });
      var blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = '客服会话导出_' + new Date().toISOString().slice(0, 10) + '.csv';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
      toast('已导出 ' + rows.length + ' 条消息');
    } catch (e) {
      if (!handleAuthError(e)) toast(e.message || '导出失败');
    } finally {
      btn.disabled = false;
    }
  }

  function switchTab(name) {
    state.tab = name;
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (x) {
      x.classList.toggle('active', x.getAttribute('data-tab') === name);
    });
    ['queue', 'overview', 'conversations', 'faq', 'gaps'].forEach(function (n) {
      var sec = $('tab-' + n);
      if (sec) sec.classList.toggle('hidden', n !== name);
    });
    if (name === 'queue') loadQueue();
    else if (name === 'overview') loadStats();
    else if (name === 'conversations') loadConversations();
    else if (name === 'faq') loadFaqs();
    else if (name === 'gaps') loadGaps();
  }

  /* ---------- 事件 ---------- */
  function bind() {
    $('gateForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      var code = $('codeInput').value.trim();
      var err = $('gateErr');
      var btn = $('gateBtn');
      if (!code) { err.textContent = '请输入口令'; return; }
      err.textContent = '';
      btn.disabled = true;
      btn.textContent = '验证中…';
      try {
        state.code = code;
        var s = await verifyCode(code);
        try { sessionStorage.setItem(CODE_KEY, code); } catch (e2) { /* 忽略 */ }
        enter(s);
      } catch (e2) {
        state.code = null;
        err.textContent = e2.message || '验证失败';
      } finally {
        btn.disabled = false;
        btn.textContent = '进入后台';
      }
    });

    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.addEventListener('click', function () { switchTab(t.getAttribute('data-tab')); });
    });

    Array.prototype.forEach.call(document.querySelectorAll('#filters .chip'), function (c) {
      c.addEventListener('click', function () {
        state.status = c.getAttribute('data-status');
        state.page = 0;
        Array.prototype.forEach.call(document.querySelectorAll('#filters .chip'), function (x) {
          x.classList.toggle('active', x === c);
        });
        loadConversations();
      });
    });

    $('refreshBtn').addEventListener('click', function () {
      if (state.tab === 'queue') loadQueue();
      else if (state.tab === 'overview') loadStats();
      else if (state.tab === 'conversations') loadConversations();
      else if (state.tab === 'faq') loadFaqs();
      else if (state.tab === 'gaps') loadGaps();
      if (state.detailId) loadDetail();
      toast('已刷新');
    });
    $('exportBtn').addEventListener('click', exportCsv);
    $('faqSave').addEventListener('click', saveFaq);
    $('faqReset').addEventListener('click', resetFaqForm);
    $('releaseBtn').addEventListener('click', releaseTicket);
    $('logoutBtn').addEventListener('click', logout);
    $('drawerClose').addEventListener('click', closeDrawer);
    $('mask').addEventListener('click', closeDrawer);
    $('replyBtn').addEventListener('click', sendReply);
    $('resolveBtn').addEventListener('click', resolve);
    $('replyInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendReply();
    });
  }

  /* ---------- 启动 ---------- */
  async function boot() {
    bind();

    // 静态预览：模式来自 assets/runtime.js 的显式声明，兼容历史的 *.github.io 判断
    var staticMode = typeof window.isStaticMode === 'function'
      ? window.isStaticMode()
      : /\.github\.io$/i.test(location.hostname);
    if (staticMode) {
      $('gateErr').textContent = '当前为 GitHub Pages 静态预览版，工作台需在服务器部署版本中使用。';
      $('codeInput').disabled = true;
      $('codeInput').placeholder = '静态预览模式不可登录';
      $('gateBtn').disabled = true;
      $('gateBtn').textContent = '不可用';
      return;
    }

    try {
      state.cloud = window.createCsCloud();
    } catch (e) {
      $('gateErr').textContent = e.message || '云服务初始化失败';
      return;
    }
    var saved = null;
    try { saved = sessionStorage.getItem(CODE_KEY); } catch (e) { /* 忽略 */ }
    if (!saved) return;
    try {
      state.code = saved;
      var s = await verifyCode(saved);
      enter(s);
    } catch (e) {
      state.code = null;
      try { sessionStorage.removeItem(CODE_KEY); } catch (e2) { /* 忽略 */ }
    }
  }

  boot();
})();
