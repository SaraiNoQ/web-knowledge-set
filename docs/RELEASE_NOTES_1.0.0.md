# 织页 `1.0.0`

`1.0.0` 从当前 `main` 打包，包含本地知识库、网页采集、Markdown 编辑与公式显示、文件夹与回收站、浏览器剪藏扩展、备份恢复、诊断和 AI 派生功能。

## macOS 安装包

- 支持 Apple Silicon，最低 macOS 13.5。
- 应用使用 ad-hoc 签名，未使用 Apple Developer ID，未经过 Apple 公证。
- 不包含自动更新通道；仅从本仓库 GitHub Release 下载并核对 `SHA256SUMS`。
- 首次启动如被 Gatekeeper 拦截，请在 Finder 中右键应用并选择“打开”；不要关闭 Gatekeeper 或使用移除隔离属性的命令。

升级前请先在“数据安全”中创建并验证完整留档。数据库迁移只向前追加，旧版本可能无法打开新 schema。
