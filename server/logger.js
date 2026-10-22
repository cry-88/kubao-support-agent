/**
 * 极简分级日志（阶段3 只负责"按环境切换等级"）
 *
 * 阶段4 会把这层换成结构化日志（traceId / 接口耗时 / JSON 行），
 * 因此这里刻意保持窄接口：debug / info / warn / error + 一个 must()。
 */
'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function create(level, tags) {
  const min = LEVELS[level] || LEVELS.info;
  const prefix = tags ? '[' + tags + ']' : '';

  const emit = (name, args) => {
    if (LEVELS[name] < min) return;
    const fn = name === 'error' ? console.error : name === 'warn' ? console.warn : console.log;
    fn.apply(console, ['[' + name + ']' + prefix].concat(args));
  };

  return {
    level,
    debug: function () { emit('debug', Array.prototype.slice.call(arguments)); },
    info: function () { emit('info', Array.prototype.slice.call(arguments)); },
    warn: function () { emit('warn', Array.prototype.slice.call(arguments)); },
    error: function () { emit('error', Array.prototype.slice.call(arguments)); },
    /** 与等级无关，必须输出（启动横幅、致命错误） */
    must: function () {
      console.log.apply(console, [prefix].concat(Array.prototype.slice.call(arguments)));
    },
    child: function (t) {
      return create(level, tags ? tags + ':' + t : t);
    },
    enabled: function (name) {
      return LEVELS[name] >= min;
    },
  };
}

module.exports = { create, LEVELS };
