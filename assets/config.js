/* 客户端数据通道（本地实现版）
 *
 * 原来的版本通过 @tencent-ai/workbuddy-cloud-sdk 直连云服务；
 * 这里换成本项目自带的 Node 服务端，接口形状完全保持不变：
 *
 *   cloud.database.rpc(name, params)      → POST /api/rpc
 *   cloud.database.from('cs_faqs')...     → GET  /api/faqs
 *   cloud.llm.models.list()              → GET  /api/models
 *   cloud.llm.chat.completions.create()   → POST /api/chat（SSE 流式）
 *
 * 因此 assets/app.js 与 assets/admin.js 里的业务逻辑无需改动。
 */
(function () {
  'use strict';

  function postJson(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (res) { return res.json(); });
  }

  /** 流式对话：把 SSE 帧解析成 { choices:[{delta:{content}}] } */
  async function* streamChat(opts) {
    var res;
    try {
      res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: opts.model,
          messages: opts.messages || [],
          temperature: opts.temperature,
        }),
        signal: opts.signal,
      });
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      throw new Error('网络异常，回复生成失败');
    }

    if (!res.ok) throw new Error('应答服务暂时不可用（' + res.status + '）');
    if (!res.body || typeof res.body.getReader !== 'function') {
      var whole = await res.json();
      var txt = whole && whole.choices && whole.choices[0] && whole.choices[0].message
        ? whole.choices[0].message.content : '';
      if (txt) yield { choices: [{ delta: { content: txt } }] };
      return;
    }

    var reader = res.body.getReader();
    var decoder = new TextDecoder('utf-8');
    var buffer = '';

    while (true) {
      var step = await reader.read();
      if (step.done) break;
      buffer += decoder.decode(step.value, { stream: true });

      var idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        var block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        var line = block.trim();
        if (!line || line.indexOf('data:') !== 0) continue;
        var payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        try {
          yield JSON.parse(payload);
        } catch (e) { /* 忽略心跳帧 */ }
      }
    }
  }

  var cloud = {
    database: {
      rpc: async function (name, params) {
        try {
          var res = await postJson('/api/rpc', { name: name, params: params || {} });
          if (res && res.data !== undefined) return { data: res.data };
          return { error: (res && res.error) || { message: '请求失败，请稍后重试' } };
        } catch (e) {
          return { error: { message: '网络异常，请检查连接后重试' } };
        }
      },

      /** 只用于公开只读的 FAQ 列表，保持与云端 from().select().order() 的用法一致 */
      from: function (table) {
        return {
          select: function () {
            var p = fetch('/api/faqs')
              .then(function (r) { return r.json(); })
              .then(function (j) { return { data: (j && j.data) || [] }; })
              .catch(function () { return { data: [], error: { message: 'FAQ 加载失败' } }; });
            return {
              order: function () { return p; },
              then: function (a, b) { return p.then(a, b); },
              catch: function (b) { return p.catch(b); },
            };
          },
        };
      },
    },

    llm: {
      models: {
        list: async function () {
          try {
            var r = await fetch('/api/models');
            return await r.json();
          } catch (e) {
            return [];
          }
        },
      },
      chat: {
        completions: {
          create: function (opts) {
            return streamChat(opts || {});
          },
        },
      },
    },
  };

  /** 创建（并复用）唯一的数据客户端 */
  window.createCsCloud = function createCsCloud() {
    if (window.__csCloud) return window.__csCloud;
    window.__csCloud = cloud;
    return window.__csCloud;
  };

  /** 统一解包 { data, error }，失败时抛出可读错误 */
  window.unwrapRpc = function unwrapRpc(result) {
    if (!result || result.error) {
      var err = new Error((result && result.error && result.error.message) || '请求失败，请稍后重试');
      err.cause = result && result.error;
      throw err;
    }
    var data = result.data;
    if (data && data.ok === false) {
      var MESSAGES = {
        unauthorized: '口令不正确或无权限',
        too_many_attempts: '登录尝试次数过多，请 10 分钟后再试',
        rate_limited: '发送太频繁，请稍后再试',
        'conversation not found': '会话不存在或已失效',
        'question and answer required': '问题和答案都不能为空',
        'faq not found': '该 FAQ 已不存在',
        not_in_queue: '该工单不在待接入队列中',
        claimed_by_other: '该工单已被其他客服接入',
        'empty content': '回复内容不能为空',
      };
      var e2 = new Error(MESSAGES[data.error] || data.error || '操作失败');
      e2.code = data.error;
      throw e2;
    }
    return data;
  };

  /** 生成/读取本机访客密钥 —— 会话归属的唯一凭证 */
  window.getGuestKey = function getGuestKey() {
    var KEY = 'cs_guest_key_v1';
    var key = null;
    try { key = localStorage.getItem(KEY); } catch (_) { /* 隐私模式 */ }
    if (!key || key.length < 16) {
      var bytes = new Uint8Array(24);
      crypto.getRandomValues(bytes);
      key = Array.from(bytes, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
      try { localStorage.setItem(KEY, key); } catch (_) { /* 忽略 */ }
    }
    return key;
  };
})();
