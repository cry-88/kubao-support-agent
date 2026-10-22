/**
 * 客户端真实 IP 解析（阶段6：可信代理改造）
 *
 * 背景：服务跑在 Nginx 后面时，socket 对端永远是 127.0.0.1，
 * 直接拿 remoteAddress 做限流键等于"全站共用一个桶"。
 *
 * 规则（保守优先）：
 *   1. 默认不信任任何代理头，只用 socket 地址
 *   2. 只有"对端确实是我们配置的可信代理"且开了 CS_TRUST_PROXY 时，才读 X-Forwarded-For
 *   3. 取 XFF 的**最后一段**——那是距离我们最近的代理（本机 Nginx）追加的，
 *      客户端自己伪造的前缀不会被采信
 *   4. 解析结果不是合法 IP 就退回 socket 地址，绝不把脏值当键用
 *
 * 已知边界：只支持"单层可信代理"。多层代理（CDN → Nginx）需要把 CDN 网段
 * 加进可信列表并按跳数剥离，属于下一步；当前拓扑（Nginx 与 Node 同机）够用。
 */
'use strict';

const net = require('net');

function normalize(ip) {
  if (!ip) return '';
  let s = String(ip).trim();
  // Windows / 双栈常见写法 ::ffff:127.0.0.1
  if (s.toLowerCase().startsWith('::ffff:')) s = s.slice(7);
  if (s === '::1') return '127.0.0.1';
  return s;
}

function isLoopback(ip) {
  const s = normalize(ip);
  return s === '127.0.0.1' || s === '::1' || s.startsWith('127.');
}

/**
 * @param {object} opts
 * @param {string} opts.peer  socket 对端地址
 * @param {string} [opts.xff] X-Forwarded-For 原始头
 * @param {boolean} opts.trust 是否启用可信代理
 * @param {string[]} [opts.trusted] 可信代理地址列表
 * @returns {{ip:string, source:'socket'|'x-forwarded-for', trusted:boolean, chain?:number, invalid?:boolean}}
 */
function resolve(opts) {
  const o = opts || {};
  const peer = normalize(o.peer) || '-';
  const trusted = (o.trusted || []).map(normalize);

  if (!o.trust || !o.xff) {
    return { ip: peer, source: 'socket', trusted: false };
  }

  const peerIsTrusted = trusted.length ? trusted.indexOf(peer) >= 0 : isLoopback(peer);
  if (!peerIsTrusted) {
    // 请求不是从可信代理来的，头一律忽略（防伪造）
    return { ip: peer, source: 'socket', trusted: false };
  }

  const chain = String(o.xff)
    .split(',')
    .map((x) => normalize(x))
    .filter(Boolean);

  if (!chain.length) return { ip: peer, source: 'socket', trusted: false, invalid: true };

  const last = chain[chain.length - 1];
  if (!net.isIP(last)) {
    return { ip: peer, source: 'socket', trusted: false, invalid: true, chain: chain.length };
  }

  return { ip: last, source: 'x-forwarded-for', trusted: true, chain: chain.length };
}

module.exports = { resolve, normalize, isLoopback };
