/**
 * 本地应答引擎：替代云端大模型通道
 *
 * 前端仍然按「chat.completions.create」的方式发一个 system + history + user 的请求，
 * 这里从 system 提示词里解析出本轮已经检索好的 FAQ 条目与订单事实，
 * 用确定性模板组合出回答 —— 不编造数字，也不需要任何模型密钥。
 *
 * 三种调用形态（沿用 app.js 的原始约定）：
 *   1) 意图分类：system 里含「意图分类器」→ 返回 JSON
 *   2) 长会话摘要：system 里含「会话摘要助手」→ 返回摘要正文
 *   3) 正常对话：解析 FAQ / 订单块后作答
 */
'use strict';

const FAQ_RE = /\[(\d+)\]\s*问题：([\s\S]*?)\n\s*回答：([\s\S]*?)(?=\n\[\d+\]\s*问题：|\n系统实时查询到的订单信息|\n系统查询结果|\n回复要求：|$)/g;

function parseFaqs(prompt) {
  const out = [];
  FAQ_RE.lastIndex = 0;
  let m;
  while ((m = FAQ_RE.exec(prompt))) {
    const q = m[2].trim();
    const a = m[3].trim();
    if (q && a) out.push({ question: q, answer: a });
  }
  return out;
}

function parseOrder(prompt) {
  if (!/系统实时查询到的订单信息/.test(prompt)) return null;
  const pick = (label) => {
    const re = new RegExp('- ' + label + '：([^\\n]+)');
    const m = prompt.match(re);
    return m ? m[1].trim() : null;
  };
  const orderNo = pick('订单号');
  if (!orderNo) return null;
  return {
    order_no: orderNo,
    item: pick('商品'),
    amount: pick('金额'),
    status: pick('状态'),
    carrier: pick('快递'),
    eta: pick('预计送达'),
  };
}

function parseIntent(prompt) {
  const m = prompt.match(/本轮系统判定的用户意图：[^（]*（([a-z]+)）/);
  return m ? m[1] : 'other';
}

function parseOrderNotFound(prompt) {
  return /订单号在系统中未找到/.test(prompt);
}

function lastUserMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i] && messages[i].role === 'user') return String(messages[i].content || '');
  }
  return '';
}

/* ---------------- 意图规则（与 assets/kb.js 保持一致） ---------------- */

const INTENT_WORDS = {
  refund: ['退款', '退钱', '退货', '退单', '返现', '补偿', '售后', '不想要了', '申请退', '退掉', '换货'],
  order: ['订单', '物流', '快递', '发货', '运单', '到哪', '签收', '配送', '什么时候到', '地址', '包裹', '单号'],
  tech: [
    '闪退', '白屏', '黑屏', '卡顿', '崩溃', '打不开', '登录不了', '登陆', '密码', '验证码', '支付失败',
    '付款失败', '报错', '用不了', '无法', '故障', '连不上', '加载',
  ],
};

function detectIntent(text) {
  const t = String(text || '').toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const key of ['refund', 'order', 'tech']) {
    let score = 0;
    for (const w of INTENT_WORDS[key]) {
      if (t.includes(w.toLowerCase())) score += w.length >= 2 ? 2 : 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = key;
    }
  }
  if (!best) return { intent: 'other', confidence: 0.2 };
  return { intent: best, confidence: Number(Math.min(0.95, 0.55 + bestScore * 0.1).toFixed(2)) };
}

/* ---------------- 回答生成 ---------------- */

const GREETING_RE = /^(你好|您好|hi|hello|嗨|在吗|在么|有人吗)[\s!！。~～]*$/i;

function buildOrderAnswer(order) {
  const parts = [];
  parts.push('订单 ' + order.order_no + (order.item ? '「' + order.item + '」' : '') + '当前状态：' + (order.status || '未知') + '。');
  if (order.carrier) {
    parts.push('承运 ' + order.carrier + (order.eta ? '，预计 ' + order.eta + ' 送达。' : '。'));
  } else if (order.eta) {
    parts.push('预计 ' + order.eta + ' 送达。');
  }
  if (order.status === '已签收') parts.push('如您还没收到包裹，我帮您联系快递核实，麻烦确认下收货地址是否正确。');
  else if (order.status === '运输中') parts.push('物流信息偶尔会延迟更新，以快递官网为准。');
  else if (order.status === '待发货') parts.push('仓库正在安排出库，发货后会给您发短信通知。');
  return parts.join('');
}

const FALLBACK = {
  refund:
    '这类退款需要核实具体订单才能推进。请把订单号和退款原因发给我，我帮您确认是否符合 7 天无理由或质量问题的处理条件。',
  order: '请把订单号发给我（形如 A2024001），我直接帮您查实时状态和物流。',
  tech: '请补充一下设备型号、系统版本和具体报错提示，我按这些信息给您对应的排查步骤。',
  other: '抱歉，这个问题我暂时没有把握回答。您可以再补充些细节，或输入「转人工」，我马上为您转接人工客服。',
};

function buildAnswer(prompt, userText) {
  const text = String(userText || '').trim();
  if (GREETING_RE.test(text)) {
    return '您好，我是哭包～ 退款售后、订单物流、技术故障都可以问我。有订单号的话直接发给我，我帮您查得更快。';
  }

  const order = parseOrder(prompt);
  if (order) return buildOrderAnswer(order);

  if (parseOrderNotFound(prompt)) {
    const m = text.match(/[A-Za-z]\d{6,10}/);
    const no = m ? m[0].toUpperCase() : '';
    return (
      '没有查到订单号' + (no ? ' ' + no : '') +
      '。麻烦您核对一下「我的订单」里的订单号（形如 A2024001），确认后我再帮您查物流和状态。'
    );
  }

  const faqs = parseFaqs(prompt);
  if (faqs.length) {
    const top = faqs[0];
    let answer = top.answer;
    // 第二条若与第一条差异足够大，补充成第二段，避免只答一半
    if (faqs[1] && faqs[1].answer !== top.answer && text.length > 14) {
      const extra = faqs[1].answer;
      if (answer.length + extra.length < 150) answer += '另外，' + extra;
    }
    return answer;
  }

  const intent = parseIntent(prompt);
  return FALLBACK[intent] || FALLBACK.other;
}

/* ---------------- 摘要 ---------------- */

function summarize(transcript) {
  const lines = String(transcript || '').split('\n').filter(Boolean);
  const userLines = lines.filter((l) => l.startsWith('用户：')).map((l) => l.slice(3));
  const botLines = lines
    .filter((l) => l.startsWith('客服：') || l.startsWith('人工客服：'))
    .map((l) => l.replace(/^(人工客服|客服)：/, ''));
  const orders = Array.from(new Set(String(transcript).match(/[A-Za-z]\d{6,10}/g) || [])).slice(0, 3);
  const handoff = /转人工|转接人工|人工客服接入/.test(transcript);

  const demand = (userLines[0] || '未明确').replace(/\s+/g, ' ').slice(0, 60);
  const answer = (botLines.length ? botLines[botLines.length - 1] : '').replace(/\s+/g, ' ').slice(0, 90);

  const parts = ['用户诉求：' + demand];
  if (orders.length) parts.push('涉及订单：' + orders.join('、'));
  if (answer) parts.push('已回复要点：' + answer);
  parts.push(handoff ? '状态：曾转人工，待坐席跟进。' : '状态：已由智能客服答复。');
  return parts.join('；').slice(0, 200);
}

/* ---------------- 统一入口 ---------------- */

const TASKS = ['answer', 'classify', 'summary', 'analytics_parse'];

/** 旧版客户端不带 task：按 system 提示词特征串推断，保证 GitHub Pages 静态版与老调用不受影响 */
function detectTask(list) {
  const system = (list.find((m) => m.role === 'system') || {}).content || '';
  if (/意图分类器/.test(system)) return 'classify';
  if (/会话摘要助手/.test(system)) return 'summary';
  return 'answer';
}

/**
 * @param {Array|{task:string, messages:Array}} input
 *   兼容两种调用：respond(messages)（旧）与 respond({task, messages})（新）
 * @returns {{text: string, task: string}}
 */
function respond(input) {
  const isLegacy = Array.isArray(input);
  const list = isLegacy ? input : ((input && input.messages) || []);
  const explicit = !isLegacy && input ? input.task : null;
  const task = TASKS.indexOf(explicit) >= 0 ? explicit : detectTask(list);

  const system = (list.find((m) => m.role === 'system') || {}).content || '';
  const userText = lastUserMessage(list);

  if (task === 'classify') {
    const target = (userText.match(/用户消息：([\s\S]*)$/) || [, userText])[1];
    const r = detectIntent(target);
    return { text: JSON.stringify({ intent: r.intent, confidence: r.confidence }), task };
  }

  if (task === 'summary') {
    return { text: summarize(userText), task };
  }

  if (task === 'analytics_parse') {
    // 预留的模型兜底位：接入真实模型后，这里返回 {"metric":"...","days":14,"filters":{...}}
    // 当前无模型凭据，返回 metric=null，由 analytics 层回退到"换个说法"提示，绝不猜测指标。
    return { text: JSON.stringify({ metric: null, reason: 'model_not_configured' }), task };
  }

  return { text: buildAnswer(system, userText), task };
}

/**
 * 数据分析的模型兜底入口：复用同一个 respond 通道，不新建模型客户端
 * @returns {Promise<object|null>} 解析出的 DSL 片段，拿不到就返回 null
 */
async function parseAnalyticsFallback(text) {
  try {
    const out = respond({ task: 'analytics_parse', messages: [{ role: 'user', content: String(text || '') }] });
    const parsed = JSON.parse(out.text);
    return parsed && parsed.metric ? parsed : null;
  } catch (e) {
    return null;
  }
}

module.exports = { respond, detectTask, parseAnalyticsFallback, detectIntent, summarize, buildAnswer, parseFaqs, parseOrder };
