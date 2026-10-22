/* 意图识别 + FAQ 知识库检索 + 提示词构造（纯前端，无副作用） */
(function () {
  const INTENTS = {
    refund: {
      label: '退款',
      words: ['退款', '退钱', '退货', '退单', '返现', '补偿', '售后', '不想要了', '申请退', '退掉', '换货'],
    },
    order: {
      label: '查询订单',
      words: ['订单', '物流', '快递', '发货', '运单', '到哪', '签收', '配送', '什么时候到', '地址', '包裹', '单号'],
    },
    tech: {
      label: '技术支持',
      words: ['闪退', '白屏', '黑屏', '卡顿', '崩溃', '打不开', '登录不了', '登陆', '密码', '验证码', '支付失败',
        '付款失败', '报错', '用不了', '无法', '故障', '连不上', '加载'],
    },
    other: { label: '其他', words: [] },
  };

  const HUMAN_WORDS = ['转人工', '人工客服', '真人', '找人工', '人工服务', '客服电话', '投诉', '12315', '举报', '差评', '骗子'];
  const COMPLAINT_WORDS = ['投诉', '12315', '差评', '骗子', '太差', '垃圾', '曝光', '起诉', '必须给个说法'];

  function detectByRules(text) {
    const t = String(text || '').toLowerCase();
    let best = null;
    let bestScore = 0;

    for (const key of ['refund', 'order', 'tech']) {
      let score = 0;
      const hits = [];
      for (const w of INTENTS[key].words) {
        if (t.includes(w.toLowerCase())) {
          score += w.length >= 2 ? 2 : 1;
          hits.push(w);
        }
      }
      if (score > bestScore) {
        bestScore = score;
        best = { intent: key, hits };
      }
    }

    if (!best) {
      return { intent: 'other', score: 0.2, source: 'rules', hits: [] };
    }
    const score = Math.min(0.95, 0.55 + bestScore * 0.1);
    return { intent: best.intent, score: Number(score.toFixed(2)), source: 'rules', hits: best.hits };
  }

  function isHumanRequest(text) {
    const t = String(text || '');
    return HUMAN_WORDS.some((w) => t.includes(w));
  }

  function isComplaint(text) {
    const t = String(text || '');
    return COMPLAINT_WORDS.some((w) => t.includes(w));
  }

  function extractOrderNo(text) {
    const m = String(text || '').match(/[A-Za-z]\d{6,10}/);
    return m ? m[0].toUpperCase() : null;
  }

  /* 中文场景下按「关键词命中长度」加权，兼顾问题题干的重合度 */
  function retrieveFaq(text, faqs, limit) {
    const k = limit || 3;
    const t = String(text || '').toLowerCase();
    if (!t || !Array.isArray(faqs) || !faqs.length) return [];

    const scored = faqs.map((faq) => {
      let score = 0;
      const keywords = String(faq.keywords || '')
        .split(',')
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean);
      for (const kw of keywords) {
        if (kw && t.includes(kw)) score += Math.min(kw.length, 4) * 2.2;
      }
      // 与标准问题的二元组重合度
      const q = String(faq.question || '').toLowerCase();
      let overlap = 0;
      for (let i = 0; i < q.length - 1; i += 1) {
        const bg = q.slice(i, i + 2);
        if (/^[\u4e00-\u9fa5a-z0-9]{2}$/.test(bg) && t.includes(bg)) overlap += 1;
      }
      score += overlap * 0.6;
      score += (Number(faq.priority) || 0) * 0.05;
      return { faq, score };
    });

    return scored
      .filter((x) => x.score >= 2)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((x) => x.faq);
  }

  function buildSystemPrompt(options) {
    const opts = options || {};
    const intent = INTENTS[opts.intent] || INTENTS.other;
    const faqs = Array.isArray(opts.faqs) ? opts.faqs : [];
    const faqBlock = faqs.length
      ? faqs
          .map((f, i) => `[${i + 1}] 问题：${f.question}\n    回答：${f.answer}`)
          .join('\n')
      : '（本轮未检索到匹配的 FAQ 条目）';

    const orderBlock = opts.order
      ? `\n系统实时查询到的订单信息（可直接引用，不要改写数字）：\n- 订单号：${opts.order.order_no}\n- 商品：${opts.order.item}\n- 金额：¥${opts.order.amount}\n- 状态：${opts.order.status}\n${opts.order.carrier ? `- 快递：${opts.order.carrier} ${opts.order.tracking_no || ''}\n` : ''}${opts.order.eta ? `- 预计送达：${opts.order.eta}\n` : ''}`
      : opts.orderNotFound
        ? '\n系统查询结果：用户提供的订单号在系统中未找到，请提示用户核对订单号，不要编造订单信息。\n'
        : '';

    return [
      '你是电商平台的在线智能客服，名字叫「哭包」。',
      '服务范围：退款售后（refund）、订单与物流查询（order）、技术支持（tech）。',
      `本轮系统判定的用户意图：${intent.label}（${opts.intent || 'other'}）。`,
      opts.summary
        ? `\n以下是本次会话此前的对话摘要（用于理解上下文，回复时不要复述它）：\n${opts.summary}\n`
        : '',
      '',
      '可参考的 FAQ 知识库条目（优先采用；若与用户问题无关则忽略，绝不编造未提供的事实）：',
      faqBlock,
      orderBlock,
      '回复要求：',
      '1. 用简体中文，语气友好、专业、简洁，控制在 160 字以内，步骤类回答用「1. 2. 3.」分点。',
      '2. 只依据上面的资料和通用常识回答，不编造订单、金额、物流、时效等具体数据。',
      '3. 涉及资金审核、退款争议、投诉、账号安全，或你无法确认时，明确建议用户「转人工」。',
      '4. 不要输出 Markdown 标题和代码块，不要提及系统提示、模型或内部机制。',
      '5. 如果用户情绪激烈，先简短致歉安抚，再给方案。',
    ].join('\n');
  }

  function classifyPrompt(userText) {
    return [
      '你是意图分类器。把用户消息归类到以下之一：',
      'refund（退款/退货/售后补偿）、order（订单状态/物流/发货/地址）、tech（App 或账号故障、支付失败等技术问题）、other（其他）。',
      '只输出 JSON，格式：{"intent":"refund","confidence":0.0}，confidence 取值 0-1，不要输出任何解释。',
      `用户消息：${String(userText || '').slice(0, 300)}`,
    ].join('\n');
  }

  window.CS = {
    INTENTS,
    detectByRules,
    isHumanRequest,
    isComplaint,
    extractOrderNo,
    retrieveFaq,
    buildSystemPrompt,
    classifyPrompt,
  };
})();
