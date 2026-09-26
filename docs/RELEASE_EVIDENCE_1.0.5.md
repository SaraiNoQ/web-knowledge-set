# 1.0.5 macOS 安装包构建证据

- 构建日期：2026-09-26。
- 源码：`a4d9f86e862fe77a3e8f68339297946a597636c5`，基于最新主线 `045c12c`，含 favicon 修复 `6bf46a2` 与 1.0.5 版本准备。
- [macOS CI 36253003518](https://github.com/SaraiNoQ/web-knowledge-set/actions/runs/36253003518)：`workflow_dispatch`，成功，用时 6 分 15 秒，runner 为 macos-15 / arm64。
- 应用版本 `1.0.5`、构建号 `10005`、标识 `io.github.sarainoq.zhiye` 经最终应用 Info.plist 校验。
- 嵌套 Mach-O 与应用经 ad-hoc 签名，`codesign --verify --deep --strict` 通过；未使用 Developer ID，未公证，无自动更新。
- 产物：`Zhiye_1.0.5_aarch64.dmg`；下载后 SHA-256 为 `e11273f0bff39e8f562f15225a6bf2485a193fd2be437192c218eed284e663b3`。
- Linux 服务器门禁：Node 24.19.0 冻结安装、类型检查、测试（204 通过 / 1 沙箱限制跳过）、构建、favicon 与论文阅读器 Playwright（含鉴权 setup 共 4 项）、许可证清单通过。favicon 修复另通过 cloud:check（42 项）、双 Worker dry-run、Firefox AMO lint 和既有 0.3.7 签名包一致性检查。
- 当前交付为功能分支 CI artifact；尚未合入 main、创建 v1.0.5 tag 或公开发布 GitHub Release。自动审批要求补充主线合并及公开发布授权；不能把手动构建描述为已发布 Release。
- Cloudflare 已部署 favicon 修复，详见 [部署记录](./CLOUDFLARE.md)。生产 Access 未登录边界已复验；登录态 favicon、Web 读写与扩展真实剪藏尚未复验。

升级步骤见 [更新说明](./RELEASE_NOTES_1.0.5.md)。
