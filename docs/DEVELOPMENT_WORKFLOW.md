# 开发与自动交付

执行规范以根目录 `AGENTS.md` / `CLAUDE.md` 为准，两份文件必须完全一致。

## 本次落地验收

- [x] ~~**贡献规范与 PR CI**：统一短期分支、阶段提交、独立审查、PR、merge commit 和 main 保护要求；固定工具链，服务器门禁、策略回归、工作流静态检查与独立审查通过，必需检查不可因跳过而误通过。GitHub 实际运行和仓库保护启用另记第三阶段。~~
- [ ] **自动生产部署**：隔离目录、非 root 专用 SSH、main 精确 SHA、累计差异、兼容迁移、签名 XPI、双 Worker 发布、失败恢复和证据留存均经过检查与独立审查。
- [ ] **仓库启用与发布验收**：main 保护、GitHub Environment 与专用凭据配置完成；首次 main 手动部署成功后开启持续部署。登录态业务验证与边界 smoke 分开记录。

## GitHub 配置

main 要求 PR、`ci-required`、分支保持最新、解决讨论，禁止强推与删除，管理员不得绕过。不要求第二个 GitHub 账号审批；独立 agent 审查证据仍必须写入 PR。采用 merge commit，合并后删除分支。

CI 在 GitHub 临时 Linux/macOS runner 运行；开发者的本地目录只编辑与同步，提交前在指定服务器验证。外部分叉 PR 不获得 SSH、Cloudflare 或生产环境凭据。

生产部署的实际配置与启用结果在后续部署阶段补全；未完成环境和凭据配置前，自动部署尚未启用。

## 第一阶段证据（2026-10-08，Asia/Singapore）

- 基线 main `0ec6d9e`，分支 `codex/agent-delivery-workflow`；未修改产品 API、数据格式或既有迁移。
- 独立服务器镜像 `/root/dev/zhiye-agent-delivery-stage1`，Node 24.19.0 / pnpm 11.7.0：类型、完整单元/集成 217 通过/1 既有跳过、构建、cloud API 45/45、双 Worker dry-run、许可证、Firefox AMO 0.3.9 通过；完整 Playwright 109/109（含 Firefox scrollbar）通过。
- 策略回归 6/6；actionlint 1.7.12 通过。服务器 GitHub 发行下载遇 TLS EOF，改为服务器通过校验的 Go 模块安装固定版本，未关闭 TLS 检查。首次 npx -c 污染内部 npm 参数导致 Firefox lint 调用失败，改为 npx -- sh -c 后完整 Firefox 门禁通过。
- 独立 agent 审查发现的危险同步父目录、摘要表追加规则及 manual→compatible/空表快照问题均修复并复审；SQL 字符串隐藏注释也有回归。GitHub/macOS 实际执行、生产发布和登录态业务验收尚未完成。
