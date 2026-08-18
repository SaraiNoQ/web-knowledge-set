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
2. **R2 资源与留档**：私有 `zhiye-cloud-backups` bucket 已绑定，支持创建、校验、导入导出和明确恢复。`.zhiye-cloud-backup` v2 保存文件夹及文档归属；导入器继续接受 v1，并把其中所有文档恢复为“未分类”。
3. **Browser Run + Queues 抓取**：`zhiye-cloud-capture` 已同时绑定生产者和消费者，消费端使用 Browser Run Markdown Quick Action。
4. **Access 与扩展迁移**：Web 由 Access 保护；独立的 `clip.sarainoq.cn` Worker 只接受扩展配对和剪藏写入，令牌不能读取、搜索、删除或导出知识库。
5. **功能等价与切换**：逐项验证编辑、搜索、导入导出、备份恢复、AI 与剪藏后，才允许将 Web 默认入口切到 Cloudflare。

本地 Node 服务和 Tauri 桌面端继续使用本地 SQLite、文件系统与 macOS 钥匙串。它们不是 Cloudflare 迁移的替代品，也不会在云端功能等价前删除。

本地与 Cloudflare Web 都只提供独立一级文件夹：新文档默认进入界面中的“根目录”（数据中仍以空 `folder_id` 表示），删除文件夹会保留文档并移回根目录。文件夹不嵌套，也不支持人工排序；可多选集合继续作为另一套分类。

两端功能等价不代表云同步。本地 SQLite 与 Cloudflare D1/R2 不会自动互传文件夹或文档，跨端迁移仍必须由用户明确导出和导入。

## 安全与发布前提

- Cloudflare API Token、Access 凭据和用户数据均不提交到仓库。云端 AI Key 只保存于当前浏览器页面内存，只随显式测试或生成请求发给 Worker，不写入 D1、R2 或诊断数据。
- 使用自定义域名且关闭可绕过 Access 的公开 Worker 地址；Access 策略默认拒绝。示例 Wrangler 配置故意不带 route：先创建 Access 应用和所有者 allow 策略，再在未跟踪的 `cloud/wrangler.web.jsonc` 中添加同一域名。
- 发布门禁必须从未登录浏览器验证 `/` 和 `/api/documents` 都被 Access 拒绝，然后再以所有者身份验证空库首屏。没有这项证据不得添加公开 route。
- 部署前需要 Cloudflare 账户授权、受管域名、D1/R2/Queues/Browser Rendering 资源标识和 Access 配置。缺少其中任一项时，只能完成源码与配置准备，不能宣称已上线。
- 本地数据迁移必须通过已验证的导出与用户明确导入，不从服务器目录静默复制，也不把 Cloudflare Web 当作同步副本。

相关官方资料：[Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)、[D1 限制](https://developers.cloudflare.com/d1/platform/limits/)、[R2](https://developers.cloudflare.com/r2/)、[Browser Run](https://developers.cloudflare.com/browser-run/)、[Queues](https://developers.cloudflare.com/queues/reference/how-queues-works/)、[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)。
