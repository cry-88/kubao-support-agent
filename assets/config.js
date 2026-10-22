/* 云服务公开配置：仅包含可安全下发到前端的公开字段
 *
 * endpoint 必须是「本应用发布域名」的数据面地址，形如 https://xxx.app.workbuddy.host，
 * 取值来自云服务激活时返回的 publicConfig.endpoint，不能随手改、也不能填 GitHub Pages 域名。
 *
 * 云服务按「来源域名」做精确校验：只有在 endpoint 对应域名下打开的页面，
 * 数据库读写与大模型调用才会放行；在 *.github.io 等其它域名下打开会被拒绝。
 * 所以 GitHub Pages 版本只做静态预览，见 assets/app.js 的静态预览模式。
 */
window.CLOUD_PUBLIC_CONFIG = {
  resourceId: 'wbcs_Ugs3mkO0xIlyh6sGmcpLbd',
  endpoint: 'https://smart-support-62853.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_yGVry6cU1Ll6vPLJmSiaC4_h8N0QFBH9NOwlV3Uv0ECsk8wfspu14zm',
};

/** 创建（并复用）唯一的云服务客户端 */
window.createCsCloud = function createCsCloud() {
  if (window.__csCloud) return window.__csCloud;
  if (typeof window.WorkBuddyCloud === 'undefined') {
    throw new Error('云服务 SDK 未能加载，请检查网络后刷新页面');
  }
  window.__csCloud = window.WorkBuddyCloud.createWorkBuddyCloud({
    endpoint: window.CLOUD_PUBLIC_CONFIG.endpoint,
    oauthRelayBaseUrl: window.CLOUD_PUBLIC_CONFIG.oauthRelayBaseUrl,
    publishableKey: window.CLOUD_PUBLIC_CONFIG.publishableKey,
  });
  return window.__csCloud;
};

/** 统一解包 { data, error }，失败时抛出可读错误 */
window.unwrapRpc = function unwrapRpc(result) {
  if (!result || result.error) {
    const err = new Error((result && result.error && result.error.message) || '请求失败，请稍后重试');
    err.cause = result && result.error;
    throw err;
  }
  const data = result.data;
  if (data && data.ok === false) {
    const MESSAGES = {
      unauthorized: '口令不正确或无权限',
      too_many_attempts: '登录尝试次数过多，请 10 分钟后再试',
      rate_limited: '发送太频繁，请稍后再试',
      'conversation not found': '会话不存在或已失效',
      'question and answer required': '问题和答案都不能为空',
      'faq not found': '该 FAQ 已不存在',
    };
    const err = new Error(MESSAGES[data.error] || data.error || '操作失败');
    err.code = data.error;
    throw err;
  }
  return data;
};

/** 生成/读取本机访客密钥 —— 会话归属的唯一凭证 */
window.getGuestKey = function getGuestKey() {
  const KEY = 'cs_guest_key_v1';
  let key = null;
  try { key = localStorage.getItem(KEY); } catch (_) { /* 隐私模式 */ }
  if (!key || key.length < 16) {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    key = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    try { localStorage.setItem(KEY, key); } catch (_) { /* 忽略 */ }
  }
  return key;
};
