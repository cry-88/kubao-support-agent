/**
 * 部署物料一致性测试（阶段6）
 *
 * 说明：这里不验证 Nginx / systemd 语法（需要真机），而是防止「文档、脚本、配置」
 * 之间出现漂移——例如脚本引用了不存在的模板、unit 里路径和文档写的不一致。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

const FILES = [
  'scripts/package.sh',
  'deploy/install.sh',
  'deploy/backup.sh',
  'deploy/rollback.sh',
  'deploy/systemd/kubao-support.service',
  'deploy/nginx/kubao-support.conf',
  'deploy/nginx/kubao-support-ip.conf',
  'deploy/env/kubao-support.env.example',
];

test('部署物料齐全', () => {
  FILES.forEach((f) => assert.ok(exists(f), '缺少 ' + f));
});

test('systemd 单元：路径与环境变量与应用一致', () => {
  const u = read('deploy/systemd/kubao-support.service');
  assert.match(u, /WorkingDirectory=\/opt\/kubao-support\/app/);
  assert.match(u, /ExecStart=\/usr\/bin\/node \/opt\/kubao-support\/app\/server\.js/);
  assert.match(u, /EnvironmentFile=\/etc\/kubao-support\/kubao-support\.env/);
  assert.match(u, /Restart=always/);
  assert.match(u, /User=kubao/);
  assert.match(u, /NoNewPrivileges=true/);
  assert.match(u, /StandardOutput=journal/);
  // 只允许写数据目录
  assert.match(u, /ReadWritePaths=\/opt\/kubao-support\/data/);
});

test('Nginx：SSE 必须关闭缓冲，并传递 X-Forwarded-For / X-Request-Id', () => {
  for (const f of ['deploy/nginx/kubao-support.conf', 'deploy/nginx/kubao-support-ip.conf']) {
    const n = read(f);
    assert.match(n, /proxy_buffering off/, f + ' 缺少 proxy_buffering off');
    assert.match(n, /X-Forwarded-For\s+\$proxy_add_x_forwarded_for/, f + ' 缺少 XFF 透传');
    assert.match(n, /X-Request-Id\s+\$request_id/, f + ' 缺少 X-Request-Id 透传');
    assert.match(n, /server 127\.0\.0\.1:8080/, f + ' 应只反代到环回地址');
    assert.match(n, /client_max_body_size 1m/, f + ' 请求体上限应与应用一致');
  }
  // 裸 IP 版本不能带 HSTS（未来上证书会被强制 https）
  const ipConf = read('deploy/nginx/kubao-support-ip.conf');
  assert.doesNotMatch(ipConf, /Strict-Transport-Security/);
});

test('生产环境模板：必须开启可信代理且口令留空由人工填写', () => {
  const env = read('deploy/env/kubao-support.env.example');
  assert.match(env, /^NODE_ENV=production$/m);
  assert.match(env, /^CS_TRUST_PROXY=true$/m);
  assert.match(env, /^HOST=127\.0\.0\.1$/m);
  assert.match(env, /^CS_LOGIN_MAX_PER_IP=/m);
  assert.match(env, /^CS_ADMIN_CODE=\s*$/m, '模板里不允许出现真实口令');
});

test('安装脚本：幂等保护（不覆盖已有环境变量、备份旧 unit、保留 releases）', () => {
  const s = read('deploy/install.sh');
  assert.match(s, /if \[ -f "\$ENV_FILE" \]/, '必须先判断环境变量文件是否存在');
  assert.match(s, /\.bak\./, '覆盖 unit 前应备份');
  assert.match(s, /mv -Tf "\$APP_DIR\/app\.new" "\$APP_DIR\/app"/, '软链切换必须是原子操作');
  assert.match(s, /KEEP_RELEASES=5/, '应限制保留版本数');
  assert.match(s, /journalctl -u kubao-support/, '健康检查失败后应输出日志提示');
});

test('打包脚本：排除业务数据与内部笔记，只收已提交内容', () => {
  const s = read('scripts/package.sh');
  assert.match(s, /EXCLUDE_RE=.*data/, '必须排除 data/');
  assert.match(s, /EXCLUDE_RE=.*\\\.workbuddy/, '必须排除内部笔记 .workbuddy/');
  assert.match(s, /EXCLUDE_RE=.*test/, '必须排除测试目录');
  assert.match(s, /git ls-files/, '默认应只打包已提交内容');
  assert.match(s, /sha256sum/, '应输出校验文件');
  assert.match(s, /业务数据与口令绝不能进发布包/, '应包含包内容自检');
  assert.match(s, /\\\.env\\\.example/, '应允许 .env.example 模板');
});

test('回滚脚本：只切代码不动数据', () => {
  const s = read('deploy/rollback.sh');
  assert.match(s, /ln -sfn "\$TARGET" "\$APP_DIR\/app\.new"/);
  assert.match(s, /systemctl restart kubao-support/);
  assert.match(s, /curl -fsS --max-time 2 http:\/\/127\.0\.0\.1:8080\/health/);
  assert.doesNotMatch(s, /rm -rf \/opt\/kubao-support\/data/, '回滚不得删除数据目录');
});

test('备份脚本：压缩包权限 600，且带自检', () => {
  const s = read('deploy/backup.sh');
  assert.match(s, /chmod 600 "\$OUT"/);
  assert.match(s, /tar -tzf "\$OUT" >\/dev\/null/, '应自检压缩包完整性');
  assert.match(s, /find "\$DEST"/, '应清理过期备份');
});

test('应用侧已支持优雅退出（systemd 发 SIGTERM）', () => {
  const s = read('server.js');
  assert.match(s, /process\.on\('SIGTERM'/);
  assert.match(s, /server\.close\(/);
});
