/**
 * 配置层（阶段3）
 *
 * 目标：一套代码，三套环境（development / test / production），配置与代码彻底分离。
 *
 * 加载顺序（后者覆盖前者）：
 *   1. 内置 profile 默认值（本文件 PROFILES）
 *   2. env/<NODE_ENV>.env      例如 env/production.env
 *   3. 项目根 .env             本地个人覆盖，不入库
 *   4. 真实进程环境变量         部署平台/容器注入，优先级最高
 *
 * 设计要点：
 *   - build() 是纯函数，测试可以直接喂一个 env 对象，不污染 process.env
 *   - 生产环境做强制校验：口令必须显式设置且不是默认值、CORS 不许通配符
 *   - 任何密钥都不出现在 toString()/runtimeConfig() 里，只暴露"是否已设置"
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENV_DIR = path.join(ROOT, 'env');

const DEFAULT_ADMIN_CODE = 'kubao-admin-2026';
const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/** 三套环境的默认值：只放"与环境强相关"的东西，业务常量不放这里 */
const PROFILES = {
  development: {
    label: '开发',
    logLevel: 'debug',
    logFormat: 'text',
    cacheStatic: false,
    chatPerMinute: 12,
    analyticsPerMinute: 30,
    bodyLimitBytes: 2 * 1024 * 1024,
    corsOrigins: ['http://localhost:8080', 'http://127.0.0.1:8080', 'http://localhost:8099'],
    strictSecurity: false,
  },
  test: {
    label: '测试',
    logLevel: 'warn',
    logFormat: 'text',
    cacheStatic: false,
    chatPerMinute: 60,
    analyticsPerMinute: 60,
    bodyLimitBytes: 2 * 1024 * 1024,
    corsOrigins: [],
    strictSecurity: false,
  },
  production: {
    label: '生产',
    logLevel: 'info',
    logFormat: 'json',
    cacheStatic: true,
    chatPerMinute: 12,
    analyticsPerMinute: 30,
    bodyLimitBytes: 1024 * 1024,
    corsOrigins: [],
    strictSecurity: true,
  },
};

function fail(msg) {
  const err = new Error('[config] ' + msg);
  err.code = 'CONFIG_INVALID';
  throw err;
}

function toBool(v, def) {
  if (v == null || v === '') return def;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].indexOf(s) >= 0) return true;
  if (['0', 'false', 'no', 'off'].indexOf(s) >= 0) return false;
  fail('无法识别的布尔值：' + v);
}

function toInt(name, v, min, max, def) {
  if (v == null || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n) || Math.floor(n) !== n) fail(name + ' 必须是整数，当前值：' + v);
  if (n < min || n > max) fail(name + ' 需在 ' + min + '~' + max + ' 之间，当前值：' + v);
  return n;
}

function toList(v) {
  if (v == null || v === '') return [];
  return String(v)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

/** 解析 .env 文本：支持 # 注释、KEY=VALUE、成对引号，不支持跨行与变量插值 */
function parseEnvText(text) {
  const out = {};
  String(text || '')
    .split(/\r?\n/)
    .forEach((line) => {
      const s = line.trim();
      if (!s || s.startsWith('#')) return;
      const i = s.indexOf('=');
      if (i <= 0) return;
      const key = s.slice(0, i).trim();
      let val = s.slice(i + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key) out[key] = val;
    });
  return out;
}

function readEnvFile(file) {
  try {
    if (!fs.existsSync(file)) return {};
    return parseEnvText(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return {};
  }
}

/**
 * 纯函数：由 env 对象生成不可变配置
 * @param {object} env 形如 process.env
 */
function build(env) {
  const e = env || {};
  const nodeEnv = String(e.NODE_ENV || 'development').trim().toLowerCase();
  if (!PROFILES[nodeEnv]) {
    fail('NODE_ENV 只支持 ' + Object.keys(PROFILES).join(' / ') + '，当前值：' + nodeEnv);
  }
  const profile = PROFILES[nodeEnv];

  const port = toInt('PORT', e.PORT, 1, 65535, 8080);
  const host = String(e.HOST || '0.0.0.0').trim();

  const logLevel = String(e.CS_LOG_LEVEL || profile.logLevel).trim().toLowerCase();
  if (!LOG_LEVELS[logLevel]) fail('CS_LOG_LEVEL 只支持 debug / info / warn / error，当前值：' + logLevel);

  const logFormat = String(e.CS_LOG_FORMAT || profile.logFormat).trim().toLowerCase();
  if (logFormat !== 'json' && logFormat !== 'text') {
    fail('CS_LOG_FORMAT 只支持 json / text，当前值：' + logFormat);
  }
  // 生产默认不输出堆栈（日志会进集中采集）；排查时可用 CS_LOG_STACK=true 临时打开
  const includeStack = toBool(e.CS_LOG_STACK, nodeEnv !== 'production');

  const staticRootRaw = String(e.CS_STATIC_ROOT || '.').trim();
  const staticRoot = path.resolve(ROOT, staticRootRaw);
  if (!fs.existsSync(staticRoot) || !fs.statSync(staticRoot).isDirectory()) {
    fail('CS_STATIC_ROOT 指向的目录不存在：' + staticRoot);
  }

  const notFoundPage = String(e.CS_NOT_FOUND_PAGE || '404.html').trim();
  const notFoundFile = path.resolve(staticRoot, notFoundPage);
  if (!fs.existsSync(notFoundFile)) {
    fail('CS_NOT_FOUND_PAGE 指向的文件不存在：' + notFoundFile);
  }

  const dataDir = path.resolve(ROOT, String(e.CS_DATA_DIR || 'data').trim());

  // CORS：显式来源列表，或开发环境下允许通配符
  const originList = e.CS_CORS_ORIGINS != null ? toList(e.CS_CORS_ORIGINS) : profile.corsOrigins.slice();
  const allowAny = originList.indexOf('*') >= 0;
  if (nodeEnv === 'production' && allowAny) {
    fail('生产环境不允许 CS_CORS_ORIGINS=*，请列出具体来源域名');
  }
  const credentials = toBool(e.CS_CORS_CREDENTIALS, false);
  if (credentials && allowAny) {
    fail('CORS 允许携带凭证时不能使用通配符来源');
  }

  const adminCode = String(e.CS_ADMIN_CODE || '');
  const usingDefaultAdminCode = !adminCode || adminCode === DEFAULT_ADMIN_CODE;
  if (profile.strictSecurity && usingDefaultAdminCode) {
    fail(
      '生产环境必须通过 CS_ADMIN_CODE 设置独立的管理员口令（不能为空或沿用默认值），' +
        '例如：CS_ADMIN_CODE=\'<你的强口令>\''
    );
  }

  const modelProvider = String(e.CS_MODEL_PROVIDER || 'local').trim();
  const modelName = String(e.CS_MODEL_NAME || 'kubao-local-reply').trim();
  const modelBaseUrl = String(e.CS_MODEL_BASE_URL || '').trim();
  const modelApiKey = String(e.CS_MODEL_API_KEY || '');

  const cfg = {
    nodeEnv,
    envLabel: profile.label,
    isDev: nodeEnv === 'development',
    isTest: nodeEnv === 'test',
    isProd: nodeEnv === 'production',

    server: {
      port,
      host,
      bodyLimitBytes: toInt('CS_BODY_LIMIT_BYTES', e.CS_BODY_LIMIT_BYTES, 1024, 50 * 1024 * 1024, profile.bodyLimitBytes),
    },

    /** 前端数据面基址：留空=同源相对路径（推荐）；跨域部署时可填绝对地址 */
    apiBase: String(e.CS_API_BASE || '').trim().replace(/\/+$/, ''),

    static: {
      root: staticRoot,
      rootRaw: staticRootRaw,
      notFoundPage,
      notFoundFile,
      cache: toBool(e.CS_STATIC_CACHE, profile.cacheStatic),
    },

    data: { dir: dataDir },

    limits: {
      chatMessagesPerMinute: toInt('CS_CHAT_RATE', e.CS_CHAT_RATE, 1, 600, profile.chatPerMinute),
      analyticsPerMinute: toInt('CS_ANALYTICS_RATE', e.CS_ANALYTICS_RATE, 1, 600, profile.analyticsPerMinute),
      loginMaxPerCode: toInt('CS_LOGIN_MAX_PER_CODE', e.CS_LOGIN_MAX_PER_CODE, 1, 100, 5),
      loginMaxGlobal: toInt('CS_LOGIN_MAX_GLOBAL', e.CS_LOGIN_MAX_GLOBAL, 1, 1000, 20),
      loginWindowMinutes: toInt('CS_LOGIN_WINDOW_MIN', e.CS_LOGIN_WINDOW_MIN, 1, 1440, 10),
    },

    cors: {
      origins: originList,
      allowAny,
      credentials,
      /** 判断某个来源是否放行；无 Origin（同源/服务端调用）一律放行 */
      allows(origin) {
        if (!origin) return true;
        if (allowAny) return true;
        return originList.indexOf(origin) >= 0;
      },
    },

    log: {
      level: logLevel,
      format: logFormat,
      includeStack,
      verbose: LOG_LEVELS[logLevel] <= LOG_LEVELS.debug,
    },

    security: {
      usingDefaultAdminCode,
      adminCodeSet: !!adminCode,
    },

    /** 模型通道：只暴露是否已配置，绝不带出 key 本身 */
    model: {
      provider: modelProvider,
      name: modelName,
      baseUrl: modelBaseUrl,
      apiKeySet: !!modelApiKey,
      enabled: modelProvider !== 'local' && !!modelApiKey,
    },
  };

  return deepFreeze(cfg);
}

/** 递归冻结，避免运行期被任意模块改写（配置是只读的） */
function deepFreeze(obj) {
  Object.getOwnPropertyNames(obj).forEach((k) => {
    const v = obj[k];
    if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
  });
  return Object.freeze(obj);
}

let cached = null;

/**
 * 读取当前进程配置：文件 + 环境变量合并
 * 注意：文件里的值会回填到 process.env，供 store 等只读模块复用
 */
function get() {
  if (cached) return cached;

  const nodeEnv = String(process.env.NODE_ENV || 'development').trim().toLowerCase();
  const merged = {};
  Object.assign(merged, readEnvFile(path.join(ENV_DIR, nodeEnv + '.env')));
  Object.assign(merged, readEnvFile(path.join(ROOT, '.env')));

  for (const k of Object.keys(process.env)) {
    if (process.env[k] !== undefined) merged[k] = process.env[k];
  }

  const cfg = build(merged);

  for (const k of Object.keys(merged)) {
    if (process.env[k] === undefined && /^(CS_|PORT$|HOST$|NODE_ENV$)/.test(k)) process.env[k] = merged[k];
  }

  cached = cfg;
  return cfg;
}

/** 重置缓存（仅测试用） */
function reset() {
  cached = null;
}

/** 可安全下发给前端/写入日志的配置摘要，不含任何密钥 */
function runtimeConfig(cfg) {
  const c = cfg || get();
  return {
    ok: true,
    env: c.nodeEnv,
    env_label: c.envLabel,
    api_base: c.apiBase || '',
    limits: {
      chat_per_minute: c.limits.chatMessagesPerMinute,
      analytics_per_minute: c.limits.analyticsPerMinute,
    },
    features: {
      analytics: true,
      model_configured: c.model.enabled,
    },
  };
}

module.exports = {
  ROOT,
  ENV_DIR,
  PROFILES,
  LOG_LEVELS,
  DEFAULT_ADMIN_CODE,
  build,
  get,
  reset,
  runtimeConfig,
  parseEnvText,
  readEnvFile,
};
