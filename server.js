/**
 * 哭包 · 智能客服 —— 服务端入口（零依赖）
 *
 * 一个进程同时做四件事：
 *   1) 静态文件服务：index.html / admin.html / assets/*（目录、404 页、缓存策略按环境配置）
 *   2) 数据接口：POST /api/rpc（对齐 schema.sql 的 28 个函数）、GET /api/faqs
 *   3) 流式应答：POST /api/chat（SSE；支持显式 task 分流）
 *   4) 运行信息：GET /api/runtime-config（供前端/运维判断环境，不含任何密钥）
 *
 * 启动：NODE_ENV=development node server.js
 * 配置：见 server/config.js 与 env/*.env.example
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

// 配置必须最先加载：它会读 env/<NODE_ENV>.env 与 .env，并把值回填给后续模块
const config = require('./server/config');

let APP_CONFIG;
try {
  APP_CONFIG = config.get();
} catch (e) {
  if (e && e.code === 'CONFIG_INVALID') {
    // 配置错误是给运维看的，只输出可读原因，不抛堆栈
    process.stderr.write('\n启动失败：' + String(e.message).replace(/^\[config\]\s*/, '') + '\n');
    process.stderr.write('请检查 env/' + String(process.env.NODE_ENV || 'development') + '.env、.env 或环境变量；变量总表见 .env.example\n\n');
    process.exit(1);
  }
  throw e;
}

const store = require('./server/store');
const rpc = require('./server/rpc');
const reply = require('./server/reply');
const analytics = require('./server/analytics');
const logger = require('./server/logger');
const health = require('./server/health');

// 日志按环境配置：生产 JSON 行、不带堆栈；开发可读文本、带堆栈
logger.configure({
  format: APP_CONFIG.log.format,
  includeStack: APP_CONFIG.log.includeStack,
  service: 'kubao-support',
});

const log = logger.create(APP_CONFIG.log.level, 'http');

const PORT = APP_CONFIG.server.port;
const HOST = APP_CONFIG.server.host;
const PUBLIC_DIR = APP_CONFIG.static.root;
const NOT_FOUND_PAGE = APP_CONFIG.static.notFoundFile;

/** 即使静态根指向项目根，也不允许直接读到的目录/文件 */
const BLOCKED_TOP_DIRS = ['data', 'env', 'server', 'test', 'node_modules', '.git', '.github', '.workbuddy'];

store.load();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.sql': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/* ---------------------------- 基础响应 ---------------------------- */

function sendJson(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

function sendNotFound(res) {
  fs.readFile(NOT_FOUND_PAGE, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    res.writeHead(404, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}

class BodyTooLarge extends Error {}

function readBody(req) {
  const limit = APP_CONFIG.server.bodyLimitBytes;
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (c) => {
      // 超限后不再累积，但仍把剩余数据读完 —— 直接 destroy 会让客户端看到连接被重置，
      // 拿不到 413 这个明确答复
      if (tooLarge) return;
      size += c.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        reject(new BodyTooLarge('payload too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!tooLarge) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (e) => {
      if (!tooLarge) reject(e);
    });
  });
}

async function readJsonBody(req, res) {
  try {
    const raw = await readBody(req);
    return { ok: true, value: JSON.parse(raw || '{}') };
  } catch (e) {
    if (e instanceof BodyTooLarge) {
      res.setHeader('Connection', 'close');
      sendJson(res, 413, { error: { message: '请求体超过上限（' + APP_CONFIG.server.bodyLimitBytes + ' 字节）' } });
    } else {
      sendJson(res, 400, { error: { message: '请求格式错误' } });
    }
    return { ok: false };
  }
}

/* ---------------------------- CORS ---------------------------- */

/**
 * 按环境放行跨域来源：白名单命中才回写头，未命中一并不写（浏览器自然拦截）。
 * 无 Origin（同源请求、curl、服务端调用）不做任何处理。
 */
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (!APP_CONFIG.cors.allows(origin)) return false;
  res.setHeader('Access-Control-Allow-Origin', APP_CONFIG.cors.allowAny ? '*' : origin);
  res.setHeader('Vary', 'Origin');
  if (APP_CONFIG.cors.credentials) res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '600');
  return true;
}

/* ---------------------------- API ---------------------------- */

async function handleRpc(req, res) {
  const body = await readJsonBody(req, res);
  if (!body.ok) return;

  const name = body.value && body.value.name;
  const params = (body.value && body.value.params) || {};
  if (!name) return sendJson(res, 400, { error: { message: '缺少函数名' } });

  try {
    const data = await rpc.call(name, params);
    return sendJson(res, 200, { data });
  } catch (e) {
    log.error('rpc ' + name + ' 执行失败：' + (e && e.stack ? e.stack : e));
    return sendJson(res, 200, { data: { ok: false, error: '服务端异常，请稍后重试' } });
  }
}

function handleFaqs(req, res) {
  const items = store.db.faqs
    .filter((f) => f.enabled)
    .slice()
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))
    .map((f) => ({
      id: f.id,
      question: f.question,
      answer: f.answer,
      category: f.category,
      keywords: f.keywords,
      priority: f.priority,
    }));
  return sendJson(res, 200, { data: items });
}

function handleModels(req, res) {
  return sendJson(res, 200, [
    {
      id: APP_CONFIG.model.name,
      name: APP_CONFIG.model.enabled ? APP_CONFIG.model.name : '哭包本地应答引擎',
      disabled: false,
      context_window: 8192,
    },
  ]);
}

function handleRuntimeConfig(req, res) {
  return sendJson(res, 200, config.runtimeConfig(APP_CONFIG));
}

/** 把答案按小片流式吐出，前端表现与真实模型一致（含「停止生成」） */
async function handleChat(req, res) {
  const body = await readJsonBody(req, res);
  if (!body.ok) return;
  const payload = body.value || {};

  const messages = payload.messages || [];
  const task = String(payload.task || '').trim();
  const ALLOWED_TASKS = ['answer', 'classify', 'summary', 'analytics'];
  if (task && ALLOWED_TASKS.indexOf(task) < 0) {
    return sendJson(res, 400, { error: { message: '不支持的任务类型：' + task, supported: ALLOWED_TASKS } });
  }

  // 数据分析会穿过全站工单，必须凭管理员口令；公开聊天页不会走这个分支
  let authCode = '';
  if (task === 'analytics') {
    authCode = String(payload.authCode || '');
    if (!rpc.checkAdmin(authCode)) {
      return sendJson(res, 403, { error: { message: '数据分析需要管理员口令（authCode）' } });
    }
  }

  let text = '';
  const modelTimer = logger.timer();
  const taskLabel = task || 'auto';
  try {
    if (task === 'analytics') {
      const result = await analytics.query({
        text: lastUserText(messages),
        db: store.db,
        actor: 'chat:' + store.md5(authCode).slice(0, 8),
        modelParse: reply.parseAnalyticsFallback,
      });
      text = analytics.formatAnswer(result);
    } else {
      // 不带 task 时由 reply 按 system 提示词推断，兼容 GitHub Pages 静态版与旧调用
      text = reply.respond({ task: task || undefined, messages }).text || '';
    }
    log.info('应答生成完成', {
      event: 'model.call',
      task: taskLabel,
      result: 'ok',
      duration_ms: modelTimer(),
      chars: text.length,
      history: Array.isArray(messages) ? messages.length : 0,
    });
  } catch (e) {
    log.error('应答生成失败', { event: 'model.call', task: taskLabel, result: 'error', duration_ms: modelTimer(), err: e });
    text = '回复生成失败，请稍后重试。';
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const id = 'chatcmpl-' + Date.now().toString(36);
  const frame = (delta, finish) =>
    'data: ' + JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: delta, finish_reason: finish || null }],
    }) + '\n\n';

  let closed = false;
  const onClose = () => {
    closed = true;
  };
  req.on('aborted', onClose);
  res.on('close', onClose);

  // 首片延迟模拟「思考」，让打字机效果更自然
  await sleep(180);
  const step = 3;
  for (let i = 0; i < text.length; i += step) {
    if (closed) return;
    res.write(frame({ content: text.slice(i, i + step) }, null));
    await sleep(18);
  }
  if (!closed) {
    res.write(frame({}, 'stop'));
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function lastUserText(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i] && list[i].role === 'user') return String(list[i].content || '');
  }
  return '';
}

/* ---------------------------- 静态文件 ---------------------------- */

function isBlockedPath(filePath) {
  const rel = path.relative(PUBLIC_DIR, filePath);
  if (rel.startsWith('..')) return true;
  const top = rel.split(path.sep)[0].toLowerCase();
  if (BLOCKED_TOP_DIRS.indexOf(top) >= 0) return true;
  const base = path.basename(filePath).toLowerCase();
  // .env / .env.production 之类一律不对外
  if (base === '.env' || base.indexOf('.env.') === 0) return true;
  return false;
}

function serveStatic(req, res, pathname) {
  const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safe);

  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('403 Forbidden');
  }
  if (isBlockedPath(filePath)) return sendNotFound(res);

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return sendNotFound(res);
    const ext = path.extname(filePath).toLowerCase();
    const isHtml = ext === '.html' || ext === '.htm';
    // HTML 永远不缓存（发布后立即生效）；静态资源按环境决定是否允许浏览器缓存
    const cache = isHtml
      ? 'no-store, no-cache, must-revalidate'
      : APP_CONFIG.static.cache
        ? 'public, max-age=3600'
        : 'no-cache';
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': cache,
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

/* ---------------------------- 链路追踪与异常兜底 ---------------------------- */

const TRACE_HEADER = 'x-request-id';

/** 复用调用方传入的 request id（如 Nginx 生成的），否则新生成一个 */
function pickTraceId(req) {
  const incoming = req.headers[TRACE_HEADER];
  if (typeof incoming === 'string' && /^[A-Za-z0-9._-]{6,64}$/.test(incoming)) return incoming;
  return logger.newTraceId();
}

function clientAddr(req) {
  return (req.socket && req.socket.remoteAddress) || '-';
}

/** 任何未预料的异常都收敛成一句人话，堆栈只进日志 */
function handleFatal(req, res, err, where) {
  log.error('请求处理异常', {
    event: 'http.error',
    where: where || 'dispatch',
    method: req.method,
    path: (req.url || '').split('?')[0],
    err: err,
  });
  const traceId = logger.currentContext().traceId || null;
  if (res.headersSent) {
    try {
      res.end();
    } catch (e) {
      /* 已经断了 */
    }
    return;
  }
  sendJson(res, 500, {
    error: { message: '服务暂时不可用，请稍后重试', trace_id: traceId },
  });
}

function handleHealth(req, res) {
  let snap;
  try {
    snap = health.snapshot();
  } catch (e) {
    log.error('健康检查异常', { event: 'health.error', err: e });
    return sendJson(res, 503, { status: 'degraded', checks: { health: { ok: false } } });
  }
  log.debug('健康检查', { event: 'health.check', status: snap.status, uptime_s: snap.uptime_s });
  return sendJson(res, snap.status === 'ok' ? 200 : 503, snap);
}

/* ---------------------------- 路由 ---------------------------- */

function dispatch(req, res, pathname) {
  const isApi = pathname.indexOf('/api/') === 0;
  if (isApi) {
    const allowed = applyCors(req, res);
    if (!allowed && req.method === 'OPTIONS') {
      return sendJson(res, 403, { error: { message: '来源不在 CORS 白名单内' } });
    }
  }

  if (req.method === 'OPTIONS') {
    if (isApi) {
      res.writeHead(204, { 'Content-Length': '0' });
      return res.end();
    }
    return sendJson(res, 404, { error: { message: '接口不存在' } });
  }

  if (req.method === 'POST') {
    if (pathname === '/api/rpc') return handleRpc(req, res);
    if (pathname === '/api/chat') return handleChat(req, res);
    return sendJson(res, 404, { error: { message: '接口不存在' } });
  }

  if (pathname === '/health' || pathname === '/api/health') return handleHealth(req, res);
  if (pathname === '/api/faqs') return handleFaqs(req, res);
  if (pathname === '/api/models') return handleModels(req, res);
  if (pathname === '/api/runtime-config') return handleRuntimeConfig(req, res);

  if (pathname === '/' || pathname === '') pathname = '/index.html';
  return serveStatic(req, res, pathname);
}

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('400 Bad Request');
  }

  const traceId = pickTraceId(req);
  res.setHeader('X-Trace-Id', traceId);

  // 整个请求（含异步链路）都跑在同一个 traceId 上下文里，业务代码不用关心
  logger.withContext({ traceId }, () => {
    const elapsed = logger.timer();
    let settled = false;

    const finish = (extra) => {
      if (settled) return;
      settled = true;
      log.info('请求完成', Object.assign(
        {
          event: 'http.request',
          method: req.method,
          path: pathname,
          status: res.statusCode,
          duration_ms: elapsed(),
          remote_addr: clientAddr(req),
        },
        extra || {}
      ));
    };
    res.on('finish', () => finish());
    res.on('close', () => finish(res.writableFinished ? {} : { aborted: true }));

    log.debug('请求开始', { event: 'http.start', method: req.method, path: pathname });

    try {
      const out = dispatch(req, res, pathname);
      if (out && typeof out.catch === 'function') {
        out.catch((e) => {
          if (e && e.constructor && e.constructor.name === 'BodyTooLarge') return;
          handleFatal(req, res, e, 'async-handler');
        });
      }
    } catch (e) {
      handleFatal(req, res, e, 'sync-handler');
    }
  });
});

server.on('clientError', (err, socket) => {
  log.warn('客户端连接异常', { event: 'http.client_error', code: err && err.code });
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(PORT, HOST, () => {
  log.must('哭包 · 智能客服已启动  env=' + APP_CONFIG.nodeEnv + '  http://localhost:' + PORT);
  log.info('静态目录：' + PUBLIC_DIR + (APP_CONFIG.static.cache ? '（允许浏览器缓存）' : '（不缓存）'));
  log.info('数据文件：' + store.DATA_FILE);
  log.info(
    '限流：聊天 ' + APP_CONFIG.limits.chatMessagesPerMinute + ' 条/分/访客，分析 ' +
      APP_CONFIG.limits.analyticsPerMinute + ' 次/分/操作者'
  );
  log.info('CORS：' + (APP_CONFIG.cors.allowAny ? '*' : APP_CONFIG.cors.origins.join(',') || '仅同源'));
  log.info('日志：level=' + APP_CONFIG.log.level + ' format=' + APP_CONFIG.log.format + ' stack=' + APP_CONFIG.log.includeStack);
  log.info('健康检查：http://localhost:' + PORT + '/health');
  if (APP_CONFIG.security.usingDefaultAdminCode) {
    log.warn('正在使用默认管理员口令，部署前务必通过 CS_ADMIN_CODE 改为独立强口令');
  }
  if (!APP_CONFIG.model.enabled) {
    log.info('模型通道：未配置（使用本地应答引擎）');
  }
});

/* 进程级兜底：永远不让堆栈裸奔到调用方，也不让进程静默假死 */
process.on('unhandledRejection', (e) => {
  log.error('未捕获的 Promise 异常', { event: 'process.unhandledRejection', err: e });
});

process.on('uncaughtException', (e) => {
  log.error('未捕获异常，进程即将退出', { event: 'process.uncaughtException', err: e });
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 50);
});
