# 发布证据

本文件只记录可复核的发布门禁结果；不记录会话 Cookie、启动令牌、API Key、正文、标题或私有路径。

## `0.9.2-rc.1` 候选阶段

### M4：可信 Web 与非 root Chromium（2026-08-13）

- 基线提交：`b2d38b9e6efccf3a38addf168f65d1672043e3b1`。
- campus-server：Node 测试 95 项通过，另 1 项按设计因 root 环境跳过；生产构建通过；Playwright 8/8；Rust fmt、Clippy 与 10 项测试通过。
- 非 root 浏览器：用阶段产出的固定 runtime、`zhiye-preview` 无登录用户和 Chromium sandbox 完成动态页面 `safe fetch → Chromium → Defuddle` 冒烟；成功及强制超时后均无代理或 Chromium 残留。
- 空库部署：临时端口启动、数据安全完整性检查、systemd 重启与二次完整性检查通过。
- 旧预览迁移：切换前创建并再次校验 schema 15 完整留档；正常停止旧 root 服务后冷复制。切换前后均为 4 篇资料，数据库 `integrity_check=ok`、外键为 0、缺失或不安全的快照/离线资源为 0。旧数据与留档保留至少七天。
- 正式预览：`/opt/zhiye-preview/current` 指向上述提交，systemd 主进程归属 `zhiye-preview`；重启后二次完整性检查通过。
- 故障回滚：注入一个必定启动失败的候选目录后，激活脚本恢复原 `current` 和运行状态；恢复后数据安全仍为正常模式且完整性通过。
- 访问边界：服务仅监听服务器 `127.0.0.1:4301`，本机通过 SSH 隧道打开 `http://127.0.0.1:4301/`；无需一次性链接，裸 API 请求仍为 401。

24 小时 soak 必须在最终 RC 代码部署后重新计时；本节不把阶段性运行时间计作最终 soak。
