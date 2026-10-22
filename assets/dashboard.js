/**
 * 阶段5 · 管理看板增强（纯追加实现）
 *
 * 设计原则：
 *   1. 不碰 admin.js：本文件独立加载，靠 DOM 观察判断"已登录 + 停在概览页"
 *   2. 数据来自单一聚合接口 cs_admin_dashboard（后端统一口径，一次请求四块数据）
 *   3. 图表用原生 SVG 画，零第三方依赖——离线部署、Pages 静态托管都不受影响
 *   4. 非管理员（坐席口令登录）会拿到 unauthorized，此时整块看板隐藏，不报错刷屏
 */
(function () {
  'use strict';

  var CODE_KEY = 'cs_admin_code_v1';
  var REFRESH_MS = 30000;
  var NS = 'http://www.w3.org/2000/svg';

  var SERIES = [
    { key: 'conversations', label: '新建工单', color: '#2b5cff' },
    { key: 'handoff', label: '转人工', color: '#f59e0b' },
    { key: 'closed', label: '已解决', color: '#0d9f6e' },
  ];

  var state = {
    loading: false,
    lastAt: 0,
    timer: null,
    days: 14,
    denied: false,
  };

  function $(id) {
    return document.getElementById(id);
  }

  function code() {
    try {
      return sessionStorage.getItem(CODE_KEY);
    } catch (e) {
      return null;
    }
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function svg(tag, attrs, text) {
    var node = document.createElementNS(NS, tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        node.setAttribute(k, attrs[k]);
      });
    }
    if (text != null) node.textContent = text;
    return node;
  }

  function fmtDuration(sec) {
    var s = Number(sec);
    if (!isFinite(s) || s < 0) return '—';
    if (s < 60) return Math.round(s) + ' 秒';
    var m = Math.floor(s / 60);
    if (m < 60) {
      var rest = Math.round(s % 60);
      return rest ? m + ' 分 ' + rest + ' 秒' : m + ' 分';
    }
    var h = Math.floor(m / 60);
    var mm = m % 60;
    return mm ? h + ' 小时 ' + mm + ' 分' : h + ' 小时';
  }

  function empty(box, msg) {
    box.innerHTML = '<div class="cs-chart-empty">' + esc(msg) + '</div>';
  }

  /* ---------------------------- 折线图 ---------------------------- */

  function renderTrend(box, sec) {
    var rows = (sec && sec.rows) || [];
    if (!rows.length) return empty(box, '暂无趋势数据');

    var W = 640;
    var H = 250;
    var pad = { l: 38, r: 16, t: 16, b: 28 };
    var plotW = W - pad.l - pad.r;
    var plotH = H - pad.t - pad.b;

    var max = 1;
    rows.forEach(function (r) {
      SERIES.forEach(function (s) {
        if (Number(r[s.key]) > max) max = Number(r[s.key]);
      });
    });

    var n = rows.length;
    var stepX = n > 1 ? plotW / (n - 1) : 0;
    function px(i) {
      return pad.l + (n > 1 ? i * stepX : plotW / 2);
    }
    function py(v) {
      return pad.t + plotH - (Number(v) / max) * plotH;
    }

    var legend =
      '<div class="cs-legend">' +
      SERIES.map(function (s) {
        return '<span><i style="background:' + s.color + '"></i>' + esc(s.label) + '</span>';
      }).join('') +
      '<span class="cs-legend-range">' + esc(sec.range.from) + ' ~ ' + esc(sec.range.to) + '</span>' +
      '</div>';

    var root = svg('svg', {
      viewBox: '0 0 ' + W + ' ' + H,
      class: 'cs-svg',
      preserveAspectRatio: 'none',
      role: 'img',
      'aria-label': '工单量趋势',
    });

    // 横向网格 + Y 轴刻度
    for (var g = 0; g <= 3; g += 1) {
      var v = (max / 3) * g;
      var y = py(v);
      root.appendChild(svg('line', { x1: pad.l, y1: y, x2: W - pad.r, y2: y, stroke: '#eef1f6', 'stroke-width': 1 }));
      root.appendChild(
        svg('text', { x: pad.l - 8, y: y + 3.5, 'text-anchor': 'end', class: 'cs-axis' }, String(Math.round(v)))
      );
    }

    // X 轴日期（隔点显示，避免挤）
    var labelEvery = n > 10 ? 2 : 1;
    rows.forEach(function (r, i) {
      if (i % labelEvery !== 0 && i !== n - 1) return;
      root.appendChild(
        svg('text', { x: px(i), y: H - 8, 'text-anchor': 'middle', class: 'cs-axis' }, String(r.day).slice(5))
      );
    });

    // 三条曲线 + 数据点
    SERIES.forEach(function (s) {
      var points = rows.map(function (r, i) {
        return px(i) + ',' + py(r[s.key]);
      });
      root.appendChild(
        svg('polyline', {
          points: points.join(' '),
          fill: 'none',
          stroke: s.color,
          'stroke-width': 2,
          'stroke-linejoin': 'round',
          'stroke-linecap': 'round',
        })
      );
      rows.forEach(function (r, i) {
        var dot = svg('circle', { cx: px(i), cy: py(r[s.key]), r: 2.8, fill: '#fff', stroke: s.color, 'stroke-width': 2 });
        var tip = svg('title', null, r.day + ' · ' + s.label + '：' + r[s.key] + (s.key === 'conversations' && r.avg_score ? '（均分 ' + r.avg_score + '）' : ''));
        dot.appendChild(tip);
        root.appendChild(dot);
      });
    });

    box.innerHTML = legend;
    box.appendChild(root);

    var foot = document.createElement('div');
    foot.className = 'cs-foot';
    foot.textContent = sec.summary || '';
    box.appendChild(foot);
  }

  /* ---------------------------- 环形图 ---------------------------- */

  var PIE_COLORS = ['#2b5cff', '#f59e0b', '#0d9f6e', '#8b5cf6', '#94a3b8', '#ef4444'];

  function renderIntent(box, sec) {
    var rows = (sec && sec.rows) || [];
    var total = rows.reduce(function (a, r) {
      return a + Number(r.count || 0);
    }, 0);
    if (!total) return empty(box, '暂无意图数据');

    var size = 220;
    var cx = size / 2;
    var cy = size / 2;
    var r = 78;
    var C = 2 * Math.PI * r;

    var root = svg('svg', { viewBox: '0 0 ' + size + ' ' + size, class: 'cs-svg cs-donut', role: 'img', 'aria-label': '意图占比' });
    root.appendChild(svg('circle', { cx: cx, cy: cy, r: r, fill: 'none', stroke: '#f1f5f9', 'stroke-width': 26 }));

    var acc = 0;
    rows.forEach(function (row, i) {
      var ratio = Number(row.count) / total;
      var seg = ratio * C;
      var color = PIE_COLORS[i % PIE_COLORS.length];
      var arc = svg('circle', {
        cx: cx,
        cy: cy,
        r: r,
        fill: 'none',
        stroke: color,
        'stroke-width': 26,
        'stroke-dasharray': seg + ' ' + (C - seg),
        'stroke-dashoffset': -acc,
        transform: 'rotate(-90 ' + cx + ' ' + cy + ')',
      });
      arc.appendChild(svg('title', null, row.label + '：' + row.count + ' 单（' + row.pct + '%）'));
      root.appendChild(arc);
      acc += seg;
    });

    root.appendChild(svg('text', { x: cx, y: cy - 4, 'text-anchor': 'middle', class: 'cs-donut-num' }, String(total)));
    root.appendChild(svg('text', { x: cx, y: cy + 16, 'text-anchor': 'middle', class: 'cs-donut-label' }, '工单'));

    var legend =
      '<ul class="cs-pie-legend">' +
      rows
        .map(function (row, i) {
          return (
            '<li><i style="background:' + PIE_COLORS[i % PIE_COLORS.length] + '"></i>' +
            '<span class="name">' + esc(row.label) + '</span>' +
            '<span class="num">' + row.count + '</span>' +
            '<span class="pct">' + row.pct + '%</span></li>'
          );
        })
        .join('') +
      '</ul>';

    box.innerHTML = '<div class="cs-pie-wrap"><div class="cs-pie-canvas"></div><div class="cs-pie-side">' + legend + '<div class="cs-foot">' + esc(sec.summary || '') + '</div></div></div>';
    box.querySelector('.cs-pie-canvas').appendChild(root);
  }

  /* ---------------------------- 坐席绩效 ---------------------------- */

  function rateBar(v) {
    var n = Math.max(0, Math.min(100, Number(v) || 0));
    return (
      '<span class="cs-rate"><span class="cs-rate-track"><span class="cs-rate-fill" style="width:' + n + '%"></span></span>' +
      '<span class="cs-rate-num">' + n + '%</span></span>'
    );
  }

  function renderAgents(box, sec) {
    var rows = (sec && sec.rows) || [];
    if (!rows.length) return empty(box, '最近没有坐席接单记录');

    var html =
      '<div class="cs-table-wrap"><table class="cs-table"><thead><tr>' +
      '<th>坐席</th><th>接单量</th><th>已解决</th><th>解决率</th><th>平均首响</th><th>评价数</th><th>好评率</th>' +
      '</tr></thead><tbody>' +
      rows
        .map(function (r) {
          return (
            '<tr>' +
            '<td class="cs-agent-name">' + esc(r.agent) + '</td>' +
            '<td class="cs-num">' + r.claimed + '</td>' +
            '<td class="cs-num">' + r.resolved + '</td>' +
            '<td>' + rateBar(r.resolve_rate) + '</td>' +
            '<td class="cs-num">' + fmtDuration(r.avg_first_response) + '</td>' +
            '<td class="cs-num">' + r.rated + '</td>' +
            '<td>' + rateBar(r.good_rate) + '</td>' +
            '</tr>'
          );
        })
        .join('') +
      '</tbody></table></div>';

    box.innerHTML = html + '<div class="cs-foot">' + esc(sec.summary || '') + '（统计窗口 ' + esc(sec.range.from) + ' ~ ' + esc(sec.range.to) + '）</div>';
  }

  /* ---------------------------- 知识缺口 ---------------------------- */

  function renderGaps(box, sec) {
    var rows = (sec && sec.rows) || [];
    if (!rows.length) return empty(box, '最近没有未命中的提问，知识库覆盖得不错');

    var html =
      '<div class="cs-gap-list">' +
      rows
        .map(function (r, i) {
          return (
            '<div class="cs-gap-row">' +
            '<span class="cs-gap-rank">' + (i + 1) + '</span>' +
            '<span class="cs-gap-badge">' + r.cnt + ' 次</span>' +
            '<span class="cs-gap-q">' + esc(r.question) + '</span>' +
            '<span class="cs-gap-meta">' + esc(r.intent_label || '') + (r.last_seen ? ' · ' + esc(r.last_seen) : '') + '</span>' +
            '</div>'
          );
        })
        .join('') +
      '</div>' +
      '<div class="cs-foot"><a href="#" class="cs-link" id="csGapMore">去「知识缺口」页批量转为 FAQ →</a></div>';

    box.innerHTML = html;
    var more = $('csGapMore');
    if (more) {
      more.addEventListener('click', function (e) {
        e.preventDefault();
        var tab = document.querySelector('.tab[data-tab="gaps"]');
        if (tab) tab.click();
      });
    }
  }

  /* ---------------------------- 加载与调度 ---------------------------- */

  function visible() {
    var consoleEl = $('console');
    var overview = $('tab-overview');
    var box = $('csDashboard');
    if (!consoleEl || !overview || !box) return false;
    return !consoleEl.classList.contains('hidden') && !overview.classList.contains('hidden');
  }

  function setHidden(hidden) {
    var box = $('csDashboard');
    if (box) box.classList.toggle('cs-hidden', !!hidden);
  }

  function showError(msg) {
    ['csChartTrend', 'csChartIntent', 'csAgentPerf', 'csGapTop'].forEach(function (id) {
      var box = $(id);
      if (box) empty(box, msg);
    });
  }

  async function load(p_days) {
    if (state.loading || state.denied) return;
    if (!visible()) return;
    var admin = code();
    if (!admin) return;

    var now = Date.now();
    if (now - state.lastAt < 1500) return; // 防抖：登录/切页会连续触发
    state.lastAt = now;
    state.loading = true;

    try {
      var cloud = window.createCsCloud();
      var res = await cloud.database.rpc('cs_admin_dashboard', {
        p_code: admin,
        p_days: p_days || state.days,
      });
      var data = window.unwrapRpc(res);
      if (!data || data.ok === false) throw new Error((data && data.error) || '看板数据加载失败');

      setHidden(false);
      renderTrend($('csChartTrend'), data.trend);
      renderIntent($('csChartIntent'), data.intent);
      renderAgents($('csAgentPerf'), data.agents);
      renderGaps($('csGapTop'), data.gaps);

      var trendHint = $('csTrendHint');
      if (trendHint) trendHint.textContent = data.trend_days + ' 天窗口 · 新建 / 转人工 / 已解决';
      var intentHint = $('csIntentHint');
      if (intentHint) intentHint.textContent = data.trend_days + ' 天窗口内新建工单的意图分布';
      var agentHint = $('csAgentHint');
      if (agentHint) agentHint.textContent = '近 ' + data.wide_days + ' 天：接单量、平均首响、解决率、好评率';
    } catch (e) {
      if (e && (e.code === 'unauthorized' || /口令|权限/.test(e.message || ''))) {
        // 坐席口令登录：看板只对管理员开放，直接隐藏，不打扰
        state.denied = true;
        setHidden(true);
      } else {
        showError('看板加载失败：' + (e && e.message ? e.message : '请稍后重试'));
      }
    } finally {
      state.loading = false;
    }
  }

  function start() {
    var targets = [$('console'), $('tab-overview')];
    if (window.MutationObserver) {
      var mo = new MutationObserver(function () {
        if (visible()) {
          state.denied = false;
          load();
        }
      });
      targets.forEach(function (node) {
        if (node) mo.observe(node, { attributes: true, attributeFilter: ['class'] });
      });
    }

    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(function () {
      if (visible()) load();
    }, REFRESH_MS);
  }

  start();
})();
