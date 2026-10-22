/* 运行模式声明（阶段7）
 *
 * 这是「服务器版」与「GitHub Pages 静态版」之间唯一需要替换的文件：
 *   - 服务器部署：保持 'server'，随仓库发布，页面直连同源 /api/*
 *   - Pages 静态版：构建时由 scripts/build-pages.sh 重写为 'static'，
 *     页面不发起任何后端请求，只做界面演示
 *   - 若静态站点要连远程后端：同时填 __CS_API_BASE__（绝对地址），并保持 mode='server'
 *
 * 注意：这个文件必须在 assets/config.js 之前加载。
 */
window.__CS_MODE__ = 'server';
window.__CS_API_BASE__ = '';
