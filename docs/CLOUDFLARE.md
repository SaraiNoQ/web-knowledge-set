# Cloudflare 云端 Web 迁移

## 状态

此文档定义迁移目标和边界；它不是部署记录。当前 Web 服务仍由 Node 后端提供，尚未部署 Cloudflare Worker，也没有迁移任何用户数据。

## 目标架构

| 能力 | Cloudflare 服务 | 迁移边界 |
| --- | --- | --- |
| Web 界面 | Workers Static Assets | Worker 与前端同域发布，避免独立静态服务器。 |
| 文档、标签、设置等云端核心数据 | D1 | 使用显式迁移；不直接复用本地 SQLite 文件。 |
| 图片、快照与完整留档 | R2 | 对象由数据库记录引用；API Key 不写入对象或数据库。 |
| 网页抓取 | Browser Rendering + Queues | 浏览器任务异步执行；继续拒绝私网、回环和受限地址。 |
| Web 访问控制 | Cloudflare Access | 默认保护应用与普通 API；仅为剪藏扩展的最小写入端点设置独立、受限入口。 |

## 分阶段实施

1. **Workers Static Assets + D1 云核心**：建立 Worker、前端静态资源和最小 D1 数据模型；从空云端知识库开始，不自动复制本地数据。当前源码只完成了此阶段的空库首屏契约；写入、采集、AI、留档和扩展仍会明确返回“待迁移”，不应用于生产数据。
2. **R2 资源与备份**：迁移离线图片、快照和完整留档的对象存储语义，并提供明确的导入、导出与恢复流程。
3. **Browser Rendering + Queues 抓取**：将公开网页抓取改为异步任务；保留现有安全 URL 校验、失败状态和手动摘录回退。
4. **Access 与扩展迁移**：为 Web 配置 Access；扩展改为只指向明确的云端剪藏入口，令牌维持最小写入权限。
5. **功能等价与切换**：逐项验证编辑、搜索、导入导出、备份恢复、AI 与剪藏后，才允许将 Web 默认入口切到 Cloudflare。

本地 Node 服务和 Tauri 桌面端继续使用本地 SQLite、文件系统与 macOS 钥匙串。它们不是 Cloudflare 迁移的替代品，也不会在云端功能等价前删除。

## 安全与发布前提

- Cloudflare API Token、Access 凭据、AI Key 和用户数据均不提交到仓库；使用 Cloudflare secret 或部署环境变量。
- 使用自定义域名且关闭可绕过 Access 的公开 Worker 地址；Access 策略默认拒绝。示例 Wrangler 配置故意不带 route：先创建 Access 应用和所有者 allow 策略，再在未跟踪的 `cloud/wrangler.web.jsonc` 中添加同一域名。
- 发布门禁必须从未登录浏览器验证 `/` 和 `/api/documents` 都被 Access 拒绝，然后再以所有者身份验证空库首屏。没有这项证据不得添加公开 route。
- 部署前需要 Cloudflare 账户授权、受管域名、D1/R2/Queues/Browser Rendering 资源标识和 Access 配置。缺少其中任一项时，只能完成源码与配置准备，不能宣称已上线。
- 本地数据迁移必须通过已验证的导出与用户明确导入，不从服务器目录静默复制。

相关官方资料：[Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)、[D1 限制](https://developers.cloudflare.com/d1/platform/limits/)、[R2](https://developers.cloudflare.com/r2/)、[Browser Run](https://developers.cloudflare.com/browser-run/)、[Queues](https://developers.cloudflare.com/queues/reference/how-queues-works/)、[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)。
