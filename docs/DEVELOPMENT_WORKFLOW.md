# 简化开发工作流

执行规范为根目录 AGENTS.md，CLAUDE.md 完全镜像。日常只需：**修改 → 定向检查 → 一个 PR → 一次独立审查 → 自动合并 → 有云端代码更新时部署**。

- 小改动不拆阶段、不强制新增台账/版本号/发布说明，不为每次提交和部署重复审查或测试。
- 文档/规则只做静态检查；小 UI 只做相关类型或布局回归；服务/云端/扩展只验证相关模块。共享 UI 不触发 macOS。
- 完整验收仅由显式大版本/正式发布请求触发：validation:release、release tag 或 full_validation=true。已知依赖审计告警须在正式发版前处理，不绑在日常 UI 修复上。
- 例行部署复用通过的 CI，只构建必要资产并执行实际发布安全守卫；策略单测不重复跑。结果保存在 Actions 摘要/artifact，正式发布或重要事故才更新 Git 证据文档。
- 工作流任务不顺带验收已上线功能、整合其他任务或启用生产。当前生产自动部署未启用；后续启用须是明确任务，并先确认 main 与线上源码一致。

## 环境与安全

本地仅编辑/Git/同步；开发检查使用指定服务器隔离镜像，固定 Node 24.19.0 / pnpm 11.7.0；CI 使用临时 runner。浏览器测试通过 scripts/run-server-e2e.sh 共享预创建锁，避免端口冲突。

main 保留 PR、ci-required、最新基线、已解决讨论和管理员同样受约束的保护。允许 merge commit、合并后删分支；单维护者不要求第二账号审批。

生产 Environment cloudflare-production 仅 main，使用专用无 sudo 的 zhiye-ci SSH 账号、固定主机指纹和生产 secrets。只发布精确已通过 CI 的 main SHA；保留迁移审批、已发布迁移不可变、精确签名 XPI 校验、双 Worker 绑定/smoke、兼容恢复和私有请求清理。发现漂移即停止，不能为了别的任务擅自推进线上验收。

高风险迁移通过 cloudflare-manual-migration 对具体 SHA 审批；未成功发布的 schema 风险跨重试保留。边界 smoke 不等于真实登录态业务验收。

macOS/AMO 只在明确发布任务执行；当前 ad-hoc 包不宣称 Apple 公证。详细生产与签名要求按需查看 CLOUDFLARE.md、FIREFOX_AMO.md，不必在小改动时通读所有历史资料。
