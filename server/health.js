/**
 * 健康检查（阶段4）
 *
 * GET /health → 200 ok / 503 degraded
 * 只暴露"能不能干活"，不暴露绝对路径、口令、密钥。
 * 判定依据：
 *   - 配置已成功加载（能跑到这里就说明通过了启动校验）
 *   - 数据目录可写（备份/落盘的前提）
 *   - store 加载无错误、最近一次写入无错误
 */
'use strict';

const fs = require('fs');

const config = require('./config');
const store = require('./store');

const startedAt = Date.now();
const SERVICE = 'kubao-support';

let version = '0.0.0';
try {
  version = require('../package.json').version;
} catch (e) {
  /* 忽略 */
}

function checkDirWritable(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.code ? e.code : 'EACCES' };
  }
}

function snapshot() {
  const cfg = config.get();
  const dataDir = checkDirWritable(cfg.data.dir);
  const state = typeof store.health === 'function' ? store.health() : { loaded: true, loadError: null, saveError: null };

  const checks = {
    config: { ok: true, env: cfg.nodeEnv },
    data_dir: { ok: dataDir.ok, writable: dataDir.ok, error: dataDir.error || null },
    store: {
      ok: !state.loadError,
      loaded: !!state.loaded,
      seeded: !!state.seeded,
      load_error: state.loadError || null,
      save_error: state.saveError || null,
      last_save_at: state.lastSaveAt || null,
    },
  };

  const ok = Object.keys(checks).every((k) => checks[k].ok);
  let counts = null;
  try {
    const db = store.db;
    counts = {
      conversations: db.conversations.length,
      messages: db.messages.length,
      faqs: db.faqs.length,
    };
  } catch (e) {
    checks.store.ok = false;
  }

  return {
    status: ok ? 'ok' : 'degraded',
    service: SERVICE,
    version,
    env: cfg.nodeEnv,
    uptime_s: Math.floor((Date.now() - startedAt) / 1000),
    node: process.version,
    memory_mb: Math.round(process.memoryUsage().rss / 1048576),
    checks,
    counts,
    time: new Date().toISOString(),
  };
}

module.exports = { snapshot, startedAt };
