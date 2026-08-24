# 发布证据

## `1.0.2` Apple Silicon `.app`

- 发布准备提交：`7caf72c234a4a4175c35c9970e39baf38dba3965`；图标嵌入修复提交：`5df0fcc4efaa5418e51bc37ba0920a11a4ce42ec`。
- 服务器门禁：类型检查、137 项测试（136 通过、1 项按 root Chromium 沙箱条件跳过）和生产构建通过；独立审查无 P0/P1。
- macOS 构建：GitHub Actions run `32732298419` 成功完成依赖审计、Apple Silicon `.app` 编译、Chromium 安全、Keychain、URL/file 入口检查和 artifact 上传。
- Actions artifact：`zhiye-app-5df0fcc4efaa5418e51bc37ba0920a11a4ce42ec`（artifact `9522153938`，SHA-256 `9441e7e7544bd518a01fa3b072d87b12ef3d52dd75b93a874d94243d98a5ad7b`，保留至 2026-08-31）。
- 实际包核验：`CFBundleShortVersionString=1.0.2`、`CFBundleVersion=1.0.2`、Apple Silicon arm64、`CFBundleIconFile=icon.icns`，内嵌图标为“纸页 + 交织线”设计；`codesign -dv` 显示 `adhoc,linker-signed`。
- 该 `.app` 没有 Developer ID 签名或 Apple 公证。
- DMG 构建与发布：GitHub Actions run `32738735936` 成功完成 ad-hoc 签名、DMG 封装、`SHA256SUMS` 生成和 GitHub Release 发布；Release [v1.0.2](https://github.com/SaraiNoQ/web-knowledge-set/releases/tag/v1.0.2) 为 immutable。
- Release 资产：`_1.0.2_aarch64.dmg`（GitHub 对中文文件名前缀做了规范化）和 `SHA256SUMS`；DMG SHA-256：`b8fc5474971cc2f69f9b2028b3e14fc6ff2800c82e376bf3714d37a6930819d8`。
- 由于 immutable Release 不能替换已规范化的中文资产名，修正版发布 run `32740393567` 创建了推荐入口 [v1.0.2-corrected](https://github.com/SaraiNoQ/web-knowledge-set/releases/tag/v1.0.2-corrected)：资产为 `Zhiye_1.0.2_aarch64.dmg`，`SHA256SUMS` 与该 ASCII 文件名匹配；DMG SHA-256：`16fb6a0dfb740fca057166c1591179799c7e75080a55e49014397c49ebeeb7cc`。

## `1.0.1` Apple Silicon DMG

- 发布准备提交：`2ccd1692635d8c1c2d0259f6d41899430c9e036e`。
- 服务器门禁：Node 24 类型检查、132 项测试（131 通过、1 项按 root Chromium 沙箱条件跳过）和生产构建通过；独立审查无 P0/P1。
- macOS 构建：GitHub Actions run `32688196058`，完成应用编译、ad-hoc 签名、DMG 封装和 artifact 上传。
- 正式 Release：`v1.0.1`，不可变且非 prerelease；包含 `Zhiye_1.0.1_aarch64.dmg` 与 `SHA256SUMS`。
- DMG SHA-256：`874913d50603f0a61fb8d8828cb5a6ea941a5820e9fd80bb98cf0801c0af51aa`。
- 该产物没有 Developer ID 签名、Apple 公证票据或自动更新通道。

## `1.0.0` Apple Silicon DMG

- 发布准备提交：`cf7a4e32dbfeb090e878a6f000867c51d8358129`。
- macOS 构建：GitHub Actions run `32653476688`，完成应用编译、ad-hoc 签名、DMG 封装和 artifact 上传。
- Actions artifact：`zhiye-dmg-cf7a4e32dbfeb090e878a6f000867c51d8358129`；应用版本和 DMG 文件名均为 `1.0.0`。
- 该产物没有 Developer ID 签名、Apple 公证票据或自动更新通道。

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

### M5：帮助与关于（2026-08-13）

- 复用现有使用指南和快捷键原生对话框，未增加第二套帮助系统或运行时依赖。
- Node 24 类型检查、生产构建和完整 Playwright 9/9 通过；测试覆盖正常与恢复模式、`?` 快捷键、Escape、焦点恢复、指南复用和安全外链。
- 独立正确性审查未发现 P0/P1。

### M5：RC 自动质量门禁（2026-08-13）

- `pnpm verify` 已统一包含类型检查、全部 Node 测试、资料库基准、许可证清单校验、生产构建和 Playwright。
- Node：95 项通过，1 项按设计仅在非 root Chromium 环境执行；提取样本覆盖英文、GFM 表格与删除线、数学源码、畸形 HTML 和脚本剔除。
- 基准：10,100 篇资料，组合查询 p95 8.66 ms；1 MiB Markdown 写入 83.02 ms；约 99 MiB 便携包导出 1208.13 ms、导入 549.63 ms，均在既定预算内。
- Playwright 10/10；Axe 未排除规则地扫描首次指南、资料库、编辑器、导入、AI、数据安全和帮助，serious/critical 为 0。
- 完整留档 E2E 真实执行导出、浏览器下载、导入但不自动恢复、创建标记资料、明确恢复导入留档，并以标记资料 404 证明数据已切换。
- Rust fmt、Clippy（警告视为错误）和 10 项测试通过；正确性与安全/数据丢失双审均未发现 P0/P1。

三次干净镜像门禁、最终 RC 的 24 小时 soak、受保护 DeepSeek smoke 和未签名资产复验尚未完成，因此“RC 质量与发布证据”台账继续保持未勾选。

- [ ] **24 小时非 root Web soak 记录**：最终 RC 的 `zhiye-preview` 服务以非 root 用户连续运行 24 小时；有界记录健康、数据完整性、RSS、FD、私有临时文件和同 runtime 孤儿进程计数，并在 systemd 重启后另行复验，证据不含 Cookie、标题或路径。

### M6：DeepSeek 真实验收自动化（2026-08-13）

- 手动 workflow 只接受完整提交 SHA；先确认触发分支为 `main`、checkout 结果精确匹配且该提交属于 `origin/main`，再进入需人工批准的 `deepseek-smoke` Environment。该 Environment 还必须限制只有 `main` 可部署，并把 `APPROVED_DEEPSEEK_SHA` 变量设为本次精确 SHA；不等时会在密钥注入前失败。
- 受保护 macOS job 使用 Node 24.19.0 和冻结锁文件构建，先以本地假 OpenAI-compatible 端点自检验收程序，再在唯一真实步骤注入 GitHub Environment 的 `DEEPSEEK_API_KEY`。
- 真实链路固定为 `https://api.deepseek.com/chat/completions` 和 `deepseek-v4-flash`；先通过连接测试 API 发送非文档探针，再通过 Markdown 导入、派生任务和结果列表 API 翻译仓库内非隐私 fixture。
- 验收断言列表、链接 URL、行内代码与代码块不变，原文修订和正文未覆盖，译文已从派生结果 API 读回；关闭应用并重开 SQLite 后再次核对原文和译文 ID/正文。程序只输出状态、固定模型、耗时和稳定错误码。
- 本节目前只记录自动化实现，不记录真实 DeepSeek 通过。仓库管理员仍需创建 `deepseek-smoke` Environment，设置 required reviewer、`main` deployment branch、精确 `APPROVED_DEEPSEEK_SHA` 和 `DEEPSEEK_API_KEY`，然后对 `main` 上已批准 SHA 手动执行并归档结果。

### M7：未签名 RC 发布工程（2026-08-13）

- `package.json`、Tauri 配置和 Cargo 版本源已统一为 `0.9.2-rc.1`；正式 identifier 保持 `io.github.sarainoq.zhiye`。
- 独立未签名 workflow 只响应精确 `v0.9.2-rc.1` tag 和手动演练；演练只上传 Actions 资产，不创建 Release。
- 构建 job 不读取 Apple 或 updater secrets，使用 Tauri `--no-sign`，不生成更新包、签名文件、公证结果或 `latest.json`。它会挂载产出 DMG，对其中的实际应用执行 release 桌面和 Chromium 安全 smoke，并断言 arm64、macOS 13.5、数字 macOS 版本元数据、无 Developer ID 身份及无 Apple 公证票据。
- 仓库管理员必须在打 tag 前预先启用 immutable releases，并把获准的 `main` 完整 SHA 写入仓库变量 `APPROVED_UNSIGNED_RC_SHA`。tag 路径会在创建 Release 前复验该变量、远程 tag 和 `main` 尖端均精确指向 `GITHUB_SHA`，再创建 draft prerelease、下载全部资产、对比精确文件清单并重算 SHA-256；只有复验通过才公开为 prerelease，且不设为 latest。公开后还必须由 `gh release view` 确认 `isImmutable=true`。
- 产物包含未签名 Apple Silicon DMG、两份 CycloneDX SBOM、`SHA256SUMS`、MIT 和第三方许可、隐私、支持与发布说明；安装说明只使用 Finder“右键→打开”，不要求关闭 Gatekeeper 或删除 quarantine。

#### `v0.9.2-rc.1` 发布尝试

- tag 指向 `298850abd76bfb4b04612fd7eeec8e6232533efc`。
- GitHub Actions run `31709549661` 因 macOS 把 `/var` 规范化为 `/private/var`，而测试故障注入仍按原路径比较而失败。流水线在发布 job 前停止，未创建 draft 或公开 GitHub Release。

#### `v0.9.2-rc.2` 待发布

- `v0.9.2-rc.2` 作为替代候选，只修正上述测试路径别名问题并同步版本与发布文档。目前尚无 tag、Release 或产物复验证据。
