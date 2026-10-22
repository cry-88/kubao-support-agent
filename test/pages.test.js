/**
 * 阶段7 · GitHub Pages 静态版测试
 *
 * 重点不是"文件在不在"，而是三件事：
 *   1. 模式判定可被显式声明覆盖（不依赖域名猜）
 *   2. 构建产物里绝不能出现后端代码与数据
 *   3. CI 上传的是构建产物，不是仓库根目录
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const HAS_BASH = (() => {
  try {
    return spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' }).status === 0;
  } catch (e) {
    return false;
  }
})();

/** 在受控的 window/location 下加载 assets/config.js，返回那个 window */
function loadConfig(opts) {
  const code = read('assets/config.js');
  const win = {};
  if (opts.mode !== undefined) win.__CS_MODE__ = opts.mode;
  if (opts.apiBase !== undefined) win.__CS_API_BASE__ = opts.apiBase;
  const fakeLocation = { hostname: opts.hostname };
  const factory = new Function('window', 'location', code + '\nreturn window;');
  return factory(win, fakeLocation);
}

test('runtime.js 默认是 server 模式，且声明为空 API 基址', () => {
  const src = read('assets/runtime.js');
  assert.match(src, /window\.__CS_MODE__\s*=\s*'server'/);
  assert.match(src, /window\.__CS_API_BASE__\s*=\s*''/);
});

test('页面必须在 config.js 之前加载 runtime.js', () => {
  for (const page of ['index.html', 'admin.html']) {
    const html = read(page);
    const iMode = html.indexOf('assets/runtime.js');
    const iConf = html.indexOf('assets/config.js');
    assert.ok(iMode > 0, page + ' 未引入 runtime.js');
    assert.ok(iConf > 0, page + ' 未引入 config.js');
    assert.ok(iMode < iConf, page + ' 中 runtime.js 必须先于 config.js 加载');
  }
});

test('模式判定：声明优先，域名兜底', () => {
  const gh = loadConfig({ hostname: 'cry-88.github.io' });
  assert.strictEqual(gh.CS_MODE, 'static');
  assert.strictEqual(gh.isStaticMode(), true);

  const local = loadConfig({ hostname: 'localhost' });
  assert.strictEqual(local.CS_MODE, 'server');
  assert.strictEqual(local.isStaticMode(), false);

  const forcedStatic = loadConfig({ hostname: 'localhost', mode: 'static' });
  assert.strictEqual(forcedStatic.CS_MODE, 'static', '显式声明应覆盖域名判断');

  const forcedServer = loadConfig({ hostname: 'x.github.io', mode: 'server' });
  assert.strictEqual(forcedServer.CS_MODE, 'server', '连远程后端时应允许强制 server');

  const bogus = loadConfig({ hostname: 'cry-88.github.io', mode: 'whatever' });
  assert.strictEqual(bogus.CS_MODE, 'static', '非法声明回退到域名判断');
});

test('接口基址：默认同源，声明后带绝对地址', () => {
  const sameOrigin = loadConfig({ hostname: 'localhost' });
  assert.strictEqual(sameOrigin.__CS_API_BASE__, undefined);
  const remote = loadConfig({ hostname: 'demo.example.com', mode: 'server', apiBase: 'https://api.example.com' });
  assert.strictEqual(remote.__CS_API_BASE__, 'https://api.example.com');
});

test('前端两个页面都改为读 isStaticMode（不再只靠域名）', () => {
  assert.match(read('assets/app.js'), /window\.isStaticMode/);
  assert.match(read('assets/admin.js'), /window\.isStaticMode/);
});

test('构建脚本：输出 dist-pages、改写 runtime、加 .nojekyll、自检后端文件', () => {
  const s = read('scripts/build-pages.sh');
  assert.match(s, /OUT="\$ROOT\/dist-pages"/);
  assert.match(s, /__CS_MODE__ = '\$MODE'/);
  assert.match(s, /: > "\$OUT\/\.nojekyll"/);
  assert.match(s, /不得包含任何后端\/配置\/数据文件/);
  assert.match(s, /CS_PAGES_API_BASE/, '应支持连远程后端的构建参数');
});

test('CI：上传构建产物而不是仓库根目录，并保留测试与密钥扫描', () => {
  const w = read('.github/workflows/deploy-pages.yml');
  assert.match(w, /path: dist-pages/, '必须只上传构建产物');
  assert.doesNotMatch(w, /path: \.\s*\n/, '不得直接上传仓库根目录');
  assert.match(w, /bash scripts\/build-pages\.sh/);
  assert.match(w, /npm test/);
  assert.match(w, /敏感信息扫描/);
  assert.match(w, /deploy-pages@v4/);
});

test('构建产物：可在真实构建后直接验证内容', { skip: !HAS_BASH }, () => {
  const r = spawnSync('bash', ['scripts/build-pages.sh'], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);

  const OUT = path.join(ROOT, 'dist-pages');
  for (const f of ['index.html', 'admin.html', '404.html', '.nojekyll', 'assets/config.js', 'assets/runtime.js', 'assets/dashboard.js']) {
    assert.ok(fs.existsSync(path.join(OUT, f)), '缺少 ' + f);
  }
  const runtime = fs.readFileSync(path.join(OUT, 'assets/runtime.js'), 'utf8');
  assert.match(runtime, /window\.__CS_MODE__ = 'static'/);
  assert.match(runtime, /window\.__CS_API_BASE__ = ''/);

  // 绝不能出现后端代码 / 数据 / 部署脚本
  for (const bad of ['server.js', 'server', 'deploy', 'scripts', 'test', 'data', '.env.example']) {
    assert.ok(!fs.existsSync(path.join(OUT, bad)), '产物不应包含 ' + bad);
  }
});

test('构建产物：指定远程 API 时切回 server 模式', { skip: !HAS_BASH }, () => {
  const r = spawnSync('bash', ['scripts/build-pages.sh'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: Object.assign({}, process.env, { CS_PAGES_API_BASE: 'https://support.example.com' }),
  });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
  const runtime = fs.readFileSync(path.join(ROOT, 'dist-pages', 'assets', 'runtime.js'), 'utf8');
  assert.match(runtime, /window\.__CS_MODE__ = 'server'/);
  assert.match(runtime, /https:\/\/support\.example\.com/);
});
