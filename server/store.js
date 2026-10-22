/**
 * 本地数据层：把 schema.sql 里的 7 张表落到一个 JSON 文件（零依赖）
 * - 进程启动时加载，找不到就按 schema.sql 的种子数据初始化
 * - 每次写操作后原子落盘（写临时文件再 rename），避免半个文件
 * - 字段名与 schema.sql 保持一致，方便日后换回 PostgreSQL
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.CS_DATA_DIR || path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');

/* 部署后的默认口令：务必在首次使用时通过环境变量或界面改掉 */
const ADMIN_CODE = process.env.CS_ADMIN_CODE || 'kubao-admin-2026';
const AGENT_CODES = [
  { name: '客服A', code: process.env.CS_AGENT_CODE_1 || 'kubao-agent-1' },
  { name: '客服B', code: process.env.CS_AGENT_CODE_2 || 'kubao-agent-2' },
];

function md5(s) {
  return crypto.createHash('md5').update(String(s == null ? '' : s), 'utf8').digest('hex');
}

function iso(d) {
  return (d instanceof Date ? d : new Date(d)).toISOString();
}

function daysFromNow(n) {
  return new Date(Date.now() + n * 24 * 3600 * 1000);
}

function dateOnly(d) {
  const x = new Date(d.getTime() + 8 * 3600 * 1000);
  return x.toISOString().slice(0, 10);
}

const FAQ_SEED = [
  ['退款政策是什么？', '支持 7 天无理由退款：商品未拆封、不影响二次销售的情况下，签收后 7 天内可全额退款。已拆封商品需经审核，若存在质量问题则不受 7 天限制。', 'refund', '退款,退钱,七天,无理由,退货,政策,退', 10],
  ['退款多久能到账？', '审核通过后 1-3 个工作日内原路退回。微信支付一般 T+1 到账，银行卡可能需 3-5 个工作日，具体以银行处理时间为准。', 'refund', '退款到账,多久,几天,原路返回,什么时候到', 9],
  ['如何申请退款？', '进入「我的订单」找到对应订单，点击「申请退款」，选择退款原因并提交。客服审核通过后自动发起退款，无需您再操作。', 'refund', '申请退款,怎么退,退款流程,退款申请,如何退款', 9],
  ['哪些情况不支持退款？', '以下情况不支持退款：定制类商品、已激活的数字商品、人为损坏的商品，以及超出 7 天且无质量问题的已拆封商品。', 'refund', '不能退,不支持退款,拆封,定制,激活', 7],
  ['怎么查询订单状态？', '进入「我的订单」即可看到全部订单及其状态（待付款 / 待发货 / 运输中 / 已签收）。已发货订单会显示快递公司与运单号，可直接追踪物流。', 'order', '查订单,订单状态,物流,发货,快递,运单号,到哪了', 10],
  ['下单后多久发货？', '现货商品在付款后 48 小时内出库，预售商品以商品页标注的发货时间为准。发货后您会收到短信通知。', 'order', '发货时间,多久发货,出库,什么时候发货', 8],
  ['可以修改收货地址吗？', '未发货订单可以修改：在订单详情页点击「修改地址」。已发货订单无法修改，建议联系快递员改派或申请拒收退回。', 'order', '改地址,收货地址,修改订单,地址错了', 8],
  ['订单可以取消吗？', '待付款订单可直接取消；待发货订单取消后会自动退款；运输中的订单需您先拒收，待包裹退回后系统自动退款。', 'order', '取消订单,不想要了,撤销订单', 7],
  ['账号无法登录怎么办？', '请先确认账号密码输入正确。若忘记密码，在登录页点击「忘记密码」通过手机号重置；若收不到验证码，请检查手机是否拦截了陌生短信，或稍后重试。', 'tech', '登录不了,登陆,密码,账号,验证码,登不上', 10],
  ['支付失败怎么处理？', '支付失败常见原因：余额不足、银行卡限额、网络超时。请先确认扣款是否成功（若已扣款请勿重复支付），然后更换支付方式重试，仍未解决请联系人工客服。', 'tech', '支付失败,付款失败,扣款,支付不了,付不了钱', 9],
  ['App 闪退或白屏怎么办？', '请先尝试：1) 完全退出 App 后重新打开；2) 检查是否为最新版本；3) 清理缓存。若仍异常，请提供手机型号与系统版本，我们会尽快排查。', 'tech', '闪退,白屏,卡顿,打不开,崩溃,黑屏', 9],
  ['如何联系人工客服？', '您可以在对话中直接输入「转人工」，系统会立即为您转接人工客服（工作时间 9:00-21:00）。也可以拨打客服电话 400-800-1234。', 'general', '人工,转人工,客服电话,真人,投诉', 10],
];

const ORDER_SEED = [
  ['A2024001', '轻氧空气净化器 Pro', 1299.0, '已签收', '顺丰速运', 'SF1234567890123', daysFromNow(-6), daysFromNow(-5), dateOnly(daysFromNow(-2))],
  ['B2024002', '智能恒温电水壶 1.5L', 329.0, '运输中', '中通快递', 'ZT7788990011223', daysFromNow(-3), daysFromNow(-2), dateOnly(daysFromNow(1))],
  ['C2024003', '无线降噪耳机 Air 2', 899.0, '待发货', null, null, daysFromNow(-0.33), null, dateOnly(daysFromNow(3))],
];

function build() {
  const now = iso(new Date());
  const db = {
    meta: { version: 1, created_at: now },
    settings: [{ key: 'admin_code', value: ADMIN_CODE, updated_at: now }],
    agents: AGENT_CODES.map((a, i) => ({
      id: i + 1,
      name: a.name,
      code: a.code,
      is_active: true,
      created_at: now,
      last_seen_at: null,
    })),
    faqs: FAQ_SEED.map((f, i) => ({
      id: i + 1,
      question: f[0],
      answer: f[1],
      category: f[2],
      keywords: f[3],
      priority: f[4],
      enabled: true,
      created_at: now,
    })),
    orders: ORDER_SEED.map((o) => ({
      order_no: o[0],
      item: o[1],
      amount: o[2],
      status: o[3],
      carrier: o[4],
      tracking_no: o[5],
      created_at: iso(o[6]),
      shipped_at: o[7] ? iso(o[7]) : null,
      eta: o[8],
    })),
    conversations: [],
    messages: [],
    login_attempts: [],
    seq: { conversations: 0, messages: 0 },
  };
  return db;
}

let db = null;

function load() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    db = JSON.parse(raw);
    if (!db.seq) db.seq = { conversations: 0, messages: 0 };
    return db;
  } catch (e) {
    db = build();
    save();
    return db;
  }
}

function save() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 1), 'utf8');
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error('[store] 保存失败：', e.message);
  }
}

function nextId(table) {
  const list = db[table];
  const max = list.reduce((m, x) => (Number(x.id) > m ? Number(x.id) : m), 0);
  const v = Math.max(max + 1, Number(db.seq[table] || 0) + 1);
  db.seq[table] = v;
  return v;
}

module.exports = {
  DATA_FILE,
  get db() {
    return db || load();
  },
  load,
  save,
  nextId,
  md5,
  iso,
  daysFromNow,
  dateOnly,
  ADMIN_CODE,
};
