# 织页 `0.9.2-rc.1`

`0.9.2-rc.1` 是功能完整预览版，用于在正式 `1.0.0` 之前验收主要功能、数据安全与发布流程。

## 重要提示

- DMG 只支持 Apple Silicon（arm64）和 macOS 13.5 或更高版本。
- DMG **没有 Apple Developer ID 签名，也没有 Apple 公证**。macOS 首次打开时会显示安全提示。
- 本版本没有自动更新通道。更换版本前，请先在“数据安全”中创建并校验完整留档。
- 这是 prerelease，不代表已完成签名、公证或正式更新验收。

## 主要能力

- 公开网页静态采集与沙箱化 Chromium 回退，保存 Markdown、HTML 快照和受支持的离线图片。
- Markdown 编辑、预览、搜索、标签、集合、收藏、归档、回收站和冲突保护。
- 单篇、批量、便携知识包与完整 `.zhiye-backup` 留档的导入导出和明确恢复。
- 默认关闭的 OpenAI-compatible AI 派生功能，包含连接测试、长文分批翻译和 Markdown 结构保真。
- 首次使用指南、帮助与关于、中文错误建议、数据诊断与备份恢复。
- 经 SSH 隧道使用的可信 localhost Web 预览模式。

## 安装

1. 从本仓库的 `v0.9.2-rc.1` GitHub prerelease 下载 `Zhiye_0.9.2-rc.1_aarch64_unsigned.dmg` 和 `SHA256SUMS`，先核对 SHA-256。
2. 打开 DMG，把“织页”拖入“应用程序”。
3. 在 Finder 的“应用程序”中右键点击“织页”，选择“打开”，再在系统提示中确认。
4. 不要关闭 Gatekeeper，也不要删除 quarantine 标记。如果无法通过上述系统界面打开，请停止安装并提交问题。

## 资产与校验

Release 同时提供 SHA-256 清单、源码与实际 DMG 内应用的 CycloneDX SBOM、MIT 许可、第三方许可清单、隐私和支持文档。GitHub 页面自动附带对应 tag 的源码归档。

数据和故障处理见 [支持文档](SUPPORT.md)，网络与 AI 数据边界见 [隐私说明](PRIVACY.md)，剩余风险见 [安全说明](SECURITY.md)。
