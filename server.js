/**
 * 哭包 · 智能客服 —— 本地服务端（零依赖）
 *
 * 一个进程同时做三件事：
 *   1) 静态文件服务：index.html / admin.html / assets/*
 *   2) 数据接口：POST /api/rpc（对齐 schema.sql 的 28 个函数）、GET /api/faqs
 *   3) 流式应答：POST /api/chat（SSE，替代云端大模型通道）
 *
 * 启动：node server.js   →  http://localhost:8080
 * 部署：监听 process.env.PORT，绑定 0.0.0.0
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const store = require('./server/store');
const rpc = require('./server/rpc');
const reply = require('./server/reply');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8080;
const PUBLIC_DIR = ROOT;

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

const NOT_FOUND_PAGE = path.join(PUBLIC_DIR, '404.html');

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
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > (limit || 2 * 1024 * 1024)) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ---------------------------- API ---------------------------- */

async function handleRpc(req, res) {
  let payload;
  try {
    payload = JSON.parse((await readBody(req)) || '{}');
  } catch (e) {
    return sendJson(res, 400, { error: { message: '请求格式错误' } });
  }
  const name = payload && payload.name;
  const params = (payload && payload.params) || {};
  if (!name) return sendJson(res, 400, { error: { message: '缺少函数名' } });
  try {
    const data = rpc.call(name, params);
    return sendJson(res, 200, { data });
  } catch (e) {
    console.error('[rpc] ' + name + ' 执行失败：', e);
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
    { id: 'kubao-local-reply', name: '哭包本地应答引擎', disabled: false, context_window: 8192 },
  ]);
}

/** 把答案按小片流式吐出，前端表现与真实模型一致（含「停止生成」） */
async function handleChat(req, res) {
  let payload;
  try {
    payload = JSON.parse((await readBody(req)) || '{}');
  } catch (e) {
    return sendJson(res, 400, { error: { message: '请求格式错误' } });
  }

  const messages = (payload && payload.messages) || [];
  let text = '';
  try {
    text = reply.respond(messages).text || '';
  } catch (e) {
    console.error('[chat] 生成失败：', e);
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

/* ---------------------------- 静态文件 ---------------------------- */

function serveStatic(req, res, pathname) {
  const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safe);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('403 Forbidden');
  }
  // 数据目录不对外暴露
  if (filePath.startsWith(path.join(PUBLIC_DIR, 'data'))) return sendNotFound(res);

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return sendNotFound(res);
    const ext = path.extname(filePath).toLowerCase();
    const isHtml = ext === '.html' || ext === '.htm';
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': isHtml ? 'no-store, no-cache, must-revalidate' : 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

/* ---------------------------- 路由 ---------------------------- */

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('400 Bad Request');
  }

  if (req.method === 'POST') {
    if (pathname === '/api/rpc') return handleRpc(req, res);
    if (pathname === '/api/chat') return handleChat(req, res);
    return sendJson(res, 404, { error: { message: '接口不存在' } });
  }

  if (pathname === '/api/faqs') return handleFaqs(req, res);
  if (pathname === '/api/models') return handleModels(req, res);

  if (pathname === '/' || pathname === '') pathname = '/index.html';
  return serveStatic(req, res, pathname);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('哭包 · 智能客服已启动：http://localhost:' + PORT);
  console.log('数据文件：' + store.DATA_FILE);
});
