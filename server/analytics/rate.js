/**
 * 数据分析 · 频率限制
 *
 * 独立于访客聊天限流（12 条/分钟）：分析查询是"重查询"，单开一档，
 * 默认每操作者 30 次/分钟，可用环境变量 CS_ANALYTICS_RATE 覆盖（阶段3 会收进配置层）。
 */
'use strict';

function createLimiter(opts) {
  const options = opts || {};
  const windowMs = Number(options.windowMs) || 60000;
  const max = Number(options.max) || 30;
  const clock = options.now || Date.now;
  const store = new Map();

  function sweep(t) {
    if (store.size < 500) return;
    for (const [k, arr] of store) {
      if (!arr.length || t - arr[arr.length - 1] >= windowMs) store.delete(k);
    }
  }

  return {
    /** @returns {{ok:true, remaining:number} | {ok:false, retry_after:number}} */
    hit(key) {
      const t = clock();
      sweep(t);
      const arr = (store.get(key) || []).filter((x) => t - x < windowMs);
      if (arr.length >= max) {
        store.set(key, arr);
        return { ok: false, retry_after: Math.max(1, Math.ceil((windowMs - (t - arr[0])) / 1000)) };
      }
      arr.push(t);
      store.set(key, arr);
      return { ok: true, remaining: max - arr.length };
    },
    reset(key) {
      store.delete(key);
    },
    get size() {
      return store.size;
    },
    config: { windowMs, max },
  };
}

module.exports = { createLimiter };
