# 界面截图

把项目截图放在这个目录下，README 的「界面截图」章节会按下面的文件名引用。

| 文件 | 对应页面 | 建议内容 |
|---|---|---|
| `01-chat.png` | `index.html` | 用户端对话，含意图标签、FAQ 命中标记、停止生成按钮 |
| `02-handoff.png` | `index.html` | 转人工等待态（含等待计时）与坐席已接入态 |
| `03-rating.png` | `index.html` | 结束咨询后的 1–5 星评价卡 |
| `04-queue.png` | `admin.html` → 工单队列 | 待接入 / 我处理中 / 超时标红 |
| `05-overview.png` | `admin.html` → 数据概览 | 满意度分布、意图分布、14 天趋势 |
| `06-faq.png` | `admin.html` → 知识库 | FAQ 增删改表单与列表 |

## 规范

- 分辨率 1440×900 或 1280×800
- 裁掉浏览器边框与系统任务栏
- PNG 格式，单张小于 500KB（可用 `pngquant` / TinyPNG 压缩）
- 截图里不要出现真实手机号、邮箱、身份信息；演示数据用虚构值

## 预览地址

- 云托管（功能完整）：见 README「部署步骤」
- GitHub Pages（仅静态预览）：https://cry-88.github.io/kubao-support-agent/

> Pages 版本受云服务来源域名校验限制，数据读写与大模型调用会被拒绝，截图请以云托管域名为准。
