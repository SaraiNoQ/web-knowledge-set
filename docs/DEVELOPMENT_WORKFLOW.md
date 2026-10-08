# 开发与自动交付

执行规范以根目录 `AGENTS.md` / `CLAUDE.md` 为准，两份文件必须完全一致。

## 本次落地验收

- [x] ~~**贡献规范与 PR CI**：统一短期分支、阶段提交、独立审查、PR、merge commit 和 main 保护要求；固定工具链，服务器门禁、策略回归、工作流静态检查与独立审查通过，必需检查不可因跳过而误通过。GitHub 实际运行和仓库保护启用另记第三阶段。~~
- [x] ~~**自动生产部署实现**：隔离目录、非 root 专用 SSH、main 精确 SHA、累计差异、兼容迁移、签名 XPI、双 Worker 发布、失败恢复和证据留存均经过服务器检查与独立审查；实际 bootstrap 与启用另记第三阶段。~~
- [ ] **仓库启用与发布验收**：main 保护、GitHub Environment 与专用凭据配置完成；首次 main 手动部署成功后开启持续部署。登录态业务验证与边界 smoke 分开记录。

## GitHub 配置

main 要求 PR、`ci-required`、分支保持最新、解决讨论，禁止强推与删除，管理员不得绕过。不要求第二个 GitHub 账号审批；独立 agent 审查证据仍必须写入 PR。采用 merge commit，合并后删除分支。

CI 在 GitHub 临时 Linux/macOS runner 运行；开发者的本地目录只编辑与同步，提交前在指定服务器验证。外部分叉 PR 不获得 SSH、Cloudflare 或生产环境凭据。

## 生产运行配置

- `cloudflare-production` Environment 只允许 main；secrets 为 `CLOUDFLARE_API_TOKEN`、`DEPLOY_SSH_KEY`、`DEPLOY_KNOWN_HOSTS`。专用密钥仅登录无 sudo 的 `zhiye-ci`，不复用管理员 key1；SSH 禁止转发和 PTY，主机指纹从既有已验证 SSH 会话取得。
- Environment variables：`DEPLOY_HOST=123.207.203.208`、`DEPLOY_USER=zhiye-ci`、`CLOUDFLARE_BOOTSTRAP_VERSIONS`（首次发布前核验的 Web/Clip 版本 JSON）。仓库变量 `CLOUDFLARE_AUTO_DEPLOY` 初始为 `false`，bootstrap 成功后才设 `true`。
- `cloudflare-manual-migration` Environment 仅允许 main，要求 SaraiNoQ 针对本次精确 SHA 审批，禁止管理员绕过；不放置生产 secrets。单维护者允许本人批准自己发起的发布，不能免除明确审批步骤。
- 服务器运行目录为 `/srv/zhiye-delivery/runs/<sha>/<run>/<attempt>/source`，state 位于 `/srv/zhiye-delivery/state`。源码无 Git metadata；私有 request 位于 source 外，0600，退出和收集阶段均删除。生产锁 `/srv/zhiye-delivery/production.lock` 覆盖完整门禁和发布。
- 共享浏览器锁 `/run/lock/zhiye-e2e.lock` 由 `/etc/tmpfiles.d/zhiye-delivery.conf` 配置为 `0660 root zhiye-ci`，启动时自动创建；通过 `bash scripts/run-server-e2e.sh` 运行，缺锁/无写权限直接失败。不要删除或重建正在使用的锁。
- 当前已签名 XPI 位于 `/srv/zhiye-delivery/signed/`。版本、文件名和摘要在 `extension/amo/signed-release.json`，必须与 AMO 证据和 manifest 一致；新版本先签名并准备精确产物，不在 Git 保存 XPI 或 AMO 凭据。
- 正式 Wrangler 配置纳入版本控制，包含现有资源 ID 和域名，不含凭据。例子配置只用于 dry-run，真实发布不得替代正式配置。

## 部署与故障处理

`Cloudflare production` 自动处理通过 CI 的 main push；手动 bootstrap/重试必须在 main 发起，填写当前完整 SHA，并已有该 SHA 的成功 push CI。首次勾选 bootstrap，核验旧 Worker 版本不漂移；成功后由维护 agent 开启仓库自动部署变量。

按上次成功发布 SHA 计算累计差异，文档/测试证据单独更新不发布，未知路径保守发布。两个 Worker 都成功且边界 smoke 通过后，才原子更新 `last-success.json`。上游 CI 失败、过时 SHA、版本漂移、缺失签名包或失败迁移都阻断发布。

新 SQL 须声明 `-- deployment: compatible` 或 `-- deployment: manual`。自动兼容分类仅支持新增表/索引和新增可空标量列；复杂 SQL 即使作者认为兼容，也使用 manual 审批并补足旧数据/新旧代码验证。既有 SQL 永不修改；`published.json` 旧摘要不变，只可在后续证据 PR 登记已合并、成功应用 SQL 的准确摘要。

manual 迁移执行前持久化 `schema-risk.json`；发布或迁移失败后，该风险继续保留，重试即使没有 pending SQL 也必须审批，且不能自动回退旧 Worker。只有当前 schema 下的双 Worker 发布和 smoke 成功才清除风险。不得通过手改 state 文件绕过漂移或兼容性检查。

失败证据记录具体门禁阶段、退出码、旧/新版本和恢复结果。兼容发布部分失败时按实际在线版本恢复旧配对；回退失败或 schema 风险不明时停止，不重复发布、不回滚数据库。通过有记录的恢复任务核验当前版本与数据，优先使用前向修复 PR；回退产品代码时保留已应用迁移历史。

运行摘要与 90 天 artifact 是部署证据原件。agent 后续以文档 PR 回写 Cloudflare/发布证据，禁止部署任务直接推 main。Access 拒绝、扩展无 Origin/无令牌拒绝仅证明边界；登录态读写、真实配对剪藏、图片及签名包实际下载另行验收。

**当前启用状态：生产 Environment、专用账号/密钥和共享锁已配置；自动部署仍为 false，尚未 bootstrap。GitHub 初次实跑的 Linux 浏览器与既有依赖审计阻塞正在修复。**

## 第一阶段证据（2026-10-08，Asia/Singapore）

- 基线 main `0ec6d9e`，分支 `codex/agent-delivery-workflow`；未修改产品 API、数据格式或既有迁移。
- 独立服务器镜像 `/root/dev/zhiye-agent-delivery-stage1`，Node 24.19.0 / pnpm 11.7.0：类型、完整单元/集成 217 通过/1 既有跳过、构建、cloud API 45/45、双 Worker dry-run、许可证、Firefox AMO 0.3.9 通过；完整 Playwright 109/109（含 Firefox scrollbar）通过。
- 策略回归 6/6；actionlint 1.7.12 通过。服务器 GitHub 发行下载遇 TLS EOF，改为服务器通过校验的 Go 模块安装固定版本，未关闭 TLS 检查。首次 npx -c 污染内部 npm 参数导致 Firefox lint 调用失败，改为 npx -- sh -c 后完整 Firefox 门禁通过。
- 独立 agent 审查发现的危险同步父目录、摘要表追加规则及 manual→compatible/空表快照问题均修复并复审；SQL 字符串隐藏注释也有回归。GitHub/macOS 实际执行、生产发布和登录态业务验收尚未完成。

## 第二阶段证据（2026-10-08，Asia/Singapore）

- 独立镜像 `/root/dev/zhiye-agent-delivery-stage2`，锁定工具链：类型、217 单元/集成通过/1 既有跳过、构建、cloud 45/45、例子与正式双 Worker dry-run、许可证及 Firefox AMO 通过。无产品路径或 SQL 变更，完整浏览器沿用本阶段前同一产品源码的 109/109；正式发布仍会在非 root 账号重新跑完整门禁。
- 策略/部署回归 18/18、actionlint 1.7.12 通过；覆盖过时 SHA、无审批迁移、迁移失败不发布、第二 Worker 上传后失败、smoke 失败、回退失败、manual-schema 已应用后重试和早期门禁失败证据。生产实际六种绑定 JSON 已用于校验回归。
- 独立 agent 审查发现并修复跨重试 schema 风险丢失、跨账号锁权限、早期失败无证据三项问题，复审无剩余发现。服务器 root/部署账号共同持锁与争锁检查通过；已配置 main 严格保护与高风险迁移审批环境。
- 首轮 GitHub CI 的 policy 通过，required 正确阻断 Linux 浏览器与 macOS 已有 npm 审计失败；Linux runner 改为兼容的 Ubuntu 22 并保留真实 Chromium sandbox probe。现有锁文件 16 high 告警将以聚焦的依赖修复阶段处理，未取消审计或跳过失败。自动部署仍未启用。
