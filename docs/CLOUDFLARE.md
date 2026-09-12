# Cloudflare 云端 Web 迁移

## 状态

Cloudflare Web 已部署在 `https://zhiye.sarainoq.cn`，并由 Access 保护。线上已支持扩展剪藏、搜索、阅读、Markdown 编辑、可选 AI、R2 留档与 Queue/Browser Run 公开网页抓取。

## 目标架构

| 能力 | Cloudflare 服务 | 迁移边界 |
| --- | --- | --- |
| Web 界面 | Workers Static Assets | Worker 与前端同域发布，避免独立静态服务器。 |
| 文档、一级文件夹、标签、设置等云端核心数据 | D1 | 使用显式迁移；不直接复用本地 SQLite 文件。 |
| 图片、快照与完整留档 | R2 | 对象由数据库记录引用；API Key 不写入对象或数据库。 |
| 网页抓取 | Browser Rendering + Queues | 浏览器任务异步执行；继续拒绝私网、回环和受限地址。 |
| Web 访问控制 | Cloudflare Access | 默认保护应用与普通 API；仅为剪藏扩展的最小写入端点设置独立、受限入口。 |

## 分阶段实施

1. **Workers Static Assets + D1 云核心**：已建立 Worker、前端静态资源和 D1 数据模型，支持扩展剪藏、搜索、阅读和标题/Markdown 编辑；本里程碑在同一 D1 核心增加一级文件夹，仍从空云端知识库开始，不自动复制本地数据。完成部署门禁前不得把新增能力描述为已上线。
2. **R2 资源与留档**：私有 `zhiye-cloud-backups` 与 `zhiye-cloud-images` bucket 已绑定，支持创建、校验、导入导出、明确恢复和确认删除。`.zhiye-cloud-backup` v5 保存文件夹、文档归属、收藏、回收站状态、AI 结果与引用图片；导入器继续接受 v1/v2/v3/v4 JSON，旧归档按兼容默认值恢复。
3. **Browser Run + Queues 抓取**：`zhiye-cloud-capture` 已同时绑定生产者和消费者；消费端优先读取页面声明的 `text/markdown` 入口，找不到时再使用 Browser Run Markdown Quick Action，并继续执行逐跳公网校验和大小限制。
4. **Access 与扩展迁移**：Web 由 Access 保护；独立的 `clip.sarainoq.cn` Worker 只接受扩展配对和剪藏写入，令牌不能读取、搜索、删除或导出知识库。
5. **功能等价与切换**：逐项验证编辑、搜索、导入导出、备份恢复、AI 与剪藏后，才允许将 Web 默认入口切到 Cloudflare。

本地 Node 服务和 Tauri 桌面端继续使用本地 SQLite、文件系统与 macOS 钥匙串。它们不是 Cloudflare 迁移的替代品，也不会在云端功能等价前删除。

本地与 Cloudflare Web 都只提供独立一级文件夹：新文档默认进入文件夹树顶层（数据中以空 `folder_id` 表示），顶层本身不是文件夹；删除文件夹会保留文档并移回顶层。文件夹不嵌套，也不支持人工排序；可多选集合继续作为另一套分类。

Cloudflare Web 的正式文档和抓取任务均支持 revision 保护的回收站生命周期。删除抓取中的任务会停止其队列发布；恢复后以失败态保留，由用户明确重试。

两端功能等价不代表云同步。本地 SQLite 与 Cloudflare D1/R2 不会自动互传文件夹或文档，跨端迁移仍必须由用户明确导出和导入。

云端图片只对新抓取或新剪藏正文按预算缓存；每张最多 5 MiB、每篇 32 张、合计 20 MiB。缓存成功后正文使用 `zhiye://asset/<sha256>`，Web 同源资源路由从 R2 提供内容；抓取失败仍保留原始 URL，但 Access/CSP 不允许预览阶段回连原站。

## 安全与发布前提

- Cloudflare API Token、Access 凭据和用户数据均不提交到仓库。云端 AI Key 只保存在 Web 域的浏览器站点存储与扩展本地存储中，只随显式测试、显式生成或用户已启用的剪藏标题请求发给 Worker，不写入 D1、R2 或诊断数据。
- 使用自定义域名且关闭可绕过 Access 的公开 Worker 地址；Access 策略默认拒绝。示例 Wrangler 配置故意不带 route：先创建 Access 应用和所有者 allow 策略，再在未跟踪的 `cloud/wrangler.web.jsonc` 中添加同一域名。
- 发布门禁必须从未登录浏览器验证 `/` 和 `/api/documents` 都被 Access 拒绝，然后再以所有者身份验证空库首屏。没有这项证据不得添加公开 route。
- 部署前需要 Cloudflare 账户授权、受管域名、D1/R2/Queues/Browser Rendering 资源标识和 Access 配置。缺少其中任一项时，只能完成源码与配置准备，不能宣称已上线。
- 本地数据迁移必须通过已验证的导出与用户明确导入，不从服务器目录静默复制，也不把 Cloudflare Web 当作同步副本。

## 部署记录

- 2026-09-10 · `c89df85` · 抓取后自动中文标题。`zhiye-web` Version ID `b174f3ec-74c2-4865-bbdc-d76f0983d408`，`zhiye-clip` Version ID `819defe0-7f35-4c68-aa55-7dc89fea3fcc`；无 D1 迁移。从 `123.207.203.208:/root/dev/zhiye` 用 `cloud/wrangler.web.jsonc` 与 `cloud/wrangler.clip.jsonc` 部署，部署前 `check`/`test`/`build`/`cloud:check`/`cloud:bundle` 全部通过。
- 未登录边界复验：`/`、`/api/documents`、`/health` 与 `POST /api/documents/<id>/auto-title` 均返回 Access 302，`clip.sarainoq.cn` 剪藏端点返回 403。
- 2026-09-11 · `4ae2850` + `8cf7246` · 左侧目录实时刷新与扩展 `0.3.4`。`zhiye-web` Version ID `5a3282be-9bad-4633-bc64-c2c463c5bffc`；`zhiye-clip` 本轮无改动，保持 `819defe0-7f35-4c68-aa55-7dc89fea3fcc`；无 D1 迁移。部署前 `check` 与 `build` 通过、`test` 148 通过 1 跳过。该版本同时把 `0.3.4` 的 Chrome/Firefox 下载包发布到“帮助 → 浏览器扩展”。未登录边界复验同上（`/`、`/api/documents`、`POST /api/documents/<id>/auto-title` 均为 Access 302）。
- 2026-09-11 · `f85345d` · 标题合规与扩展密钥修复。`zhiye-web` Version ID `dfb40684-c4cb-4e8b-936e-c82540ce4841`，`zhiye-clip` Version ID `adf33b68-1665-4c8c-a83c-4234c28e3862`；无 D1 迁移。部署前 `check`、`test`（153 通过、1 跳过）、`build`、`cloud:check`（28 通过）、`cloud:bundle`、`firefox:amo`（0.3.5 通过）全部通过。未登录边界复验：`/`、`/api/documents`、`/health` 与 `POST /api/documents/<id>/auto-title` 均为 Access 302；`clip.sarainoq.cn` 无 Origin 剪藏请求 403 `EXTENSION_ORIGIN_REJECTED`，带扩展 Origin 但无令牌 401 `EXTENSION_UNAUTHORIZED`，携带 `x-zhiye-llm-key` 的预检 204。
- 2026-09-11 · `9ea2023` · 论文对照阅读上线。先在现有 `zhiye-cloud` D1 应用唯一待执行的 `0009_cloud_papers.sql`，仅新增论文字段、表和资源关联，未删除或重写既有数据；迁移后远端显示无待迁移、13 张表。`zhiye-web` Version ID `b103d0f0-6bbc-4294-ac2e-c31abd2db4bf`，`zhiye-clip` Version ID `45702c2c-d134-42de-9f01-2c7cf4e4fae5`。部署前 Node 24.19.0 `check`、`test`（155 通过、1 跳过）、`build`、`cloud:check`（29 通过）、`cloud:bundle` 全部通过；未登录边界复验：Web `/` 与 `/api/documents` 返回 Access 302，`clip.sarainoq.cn/` 返回 403。
- 2026-09-11 · `b237840` · 论文 PDF 不兼容错误提示、云端失败详情回显与阅读器头部间距修复。无 D1 迁移，远端保持 13 张表且无待迁移；`zhiye-web` Version ID `e2e8da6a-47f2-4c3a-aa41-251f43361160`，`zhiye-clip` Version ID `b6b87d64-63f6-4182-a567-886b6407aa19`。部署前 Node 24.19.0 `check`、`test`（157 通过、1 跳过）、`build`、`cloud:check`（30 通过）、`cloud:bundle`、论文 Playwright E2E（2/2）全部通过；未登录边界复验：Web `/` 与 `/api/documents` 返回 Access 302，`clip.sarainoq.cn/` 返回 403。
- 2026-09-11 · `98837e4` · 论文回收站删除、共享 PDF 清理与服务端 document revision 修复。无 D1 迁移，生产 D1 确认无待执行迁移；`zhiye-web` Version ID `50f6ecaf-b389-4e87-8437-12899da8a2a7`，`zhiye-clip` Version ID `2675f963-b5ef-4b5d-a717-61369415453e`。部署前 Node 24.19.0 `check`、`test`（161 通过、1 跳过）、`build`、`cloud:check`（32 通过）、`cloud:bundle`、论文 Playwright E2E（2/2）全部通过；未登录边界复验：Web `/`、`/api/documents` 与 `/health` 返回 Access 302，`clip.sarainoq.cn/` 返回 403。
- 2026-09-12 · `ef03da7` · 论文页图通道与分批提取。先在现有 `zhiye-cloud` D1 应用唯一待执行的 `0010_cloud_paper_content_mode.sql`（`cloud_paper_extractions` 仅新增一个可空 `content_mode` 列，旧版本 Worker 会忽略它，因此迁移先于代码部署是安全的）；迁移后远端显示无待迁移。`zhiye-web` Version ID `64425185-71de-45ac-911e-e24dca5a94d7`，`zhiye-clip` Version ID `ece82d4d-4313-4285-8b60-c1e45feab114`。部署前 Node 24.19.0 `check`、`test`（170 通过、1 跳过）、`build`、`cloud:check`（33 通过）、`cloud:bundle`、论文 Playwright E2E（2/2）全部通过。未登录边界复验：Web `/`、`/api/documents`、`/health`、`GET /api/papers/<id>/extraction-plan`、`GET /api/paper-tasks/<id>`、`POST /api/documents/<id>/auto-title` 与 `PUT /api/papers/<id>/pages/1/image` 均为 Access 302；`clip.sarainoq.cn` 无 Origin 403 `EXTENSION_ORIGIN_REJECTED`、非扩展 Origin 403、带扩展 Origin 无令牌 401 `EXTENSION_UNAUTHORIZED`、携带 `x-zhiye-llm-key` 的预检 204。
- 待补：以所有者身份用真实 DeepSeek 端点重新提取一篇长论文，确认页图通道产出分页对照（`docs/FEATURES.md` 的页图通道验收项因此仍未勾选）。
- 待补：以所有者身份完成抓取、扩展剪藏与本地抓取三端的真实标题替换验证；`0.3.5` 已在 AMO 自签名（unlisted，见 [FIREFOX_AMO.md](./FIREFOX_AMO.md)），若要走商店安装仍需提交审核并更新安装链接。

相关官方资料：[Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)、[D1 限制](https://developers.cloudflare.com/d1/platform/limits/)、[R2](https://developers.cloudflare.com/r2/)、[Browser Run](https://developers.cloudflare.com/browser-run/)、[Queues](https://developers.cloudflare.com/queues/reference/how-queues-works/)、[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)。
