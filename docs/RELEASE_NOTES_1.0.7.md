# 织页 1.0.7

- Markdown 从 Finder 打开后在后台导入并直接显示阅读预览，不再先显示导入界面。
- 新增 Apple Silicon PKG 安装包。先保存并退出织页，再打开安装包覆盖旧版，无需卸载；应用外的知识库数据保留。
- 更新 JavaScript 与 Rust 依赖，修复 XML、图片处理、HTTP、数学渲染、TLS、证书与 ZIP 解压安全问题。updater 固定到官方 ZIP 修复提交，保留跨平台更新包支持。

带来源链接的 Markdown 沿用已有资料匹配规则；无来源文件再次导入会新增副本，不覆盖原有内容。

最低支持 macOS 13.5，适用于 Apple Silicon。应用为 ad-hoc 签名，未经过 Apple Developer ID 签名或 Apple 公证；未配置在线自动更新。下载后可使用 SHA256SUMS 核对安装文件。
