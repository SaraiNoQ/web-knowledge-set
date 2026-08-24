# 织页 `1.0.1`

`1.0.1` 从当前 `main` 打包，包含 `1.0.0` 之后的界面、浏览器剪藏与云端留档修复。

## 主要变化

- 云端抓取可安全下载、校验、保存并显示正文图片。
- 云端完整留档携带文档图片，桌面端可导入云端 `.zhiye-cloud-backup`。
- 阅读界面、收藏、回收站、公式显示和返回标题操作完成收尾。
- Chrome/Firefox 剪藏扩展增强公式保真并准备 Firefox AMO 发布。

## macOS 安装包

- 支持 Apple Silicon，最低 macOS 13.5。
- 应用使用 ad-hoc 签名，未使用 Apple Developer ID，未经过 Apple 公证。
- 不包含自动更新通道；仅从本仓库 GitHub Release 下载并核对 `SHA256SUMS`。
- 首次启动如被 Gatekeeper 拦截，请在 Finder 中右键应用并选择“打开”；不要关闭 Gatekeeper 或移除隔离属性。

升级前请先在“数据安全”中创建并验证完整留档。
