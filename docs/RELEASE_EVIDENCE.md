# 发布证据

## `1.0.4` Apple Silicon DMG

- 发布准备提交：`97d26808b49c943890a099be8280ba5de6baaebd`；该提交包含 AI 远程端点安全公网 DNS 解析修复和统一的 1.0.4 版本源。
- macOS DMG workflow：GitHub Actions run `33065590681` 成功完成 main tip 校验、版本断言、Apple Silicon 应用编译、ad-hoc 签名、DMG 封装、artifact 上传和 checksum 生成。
- 正式 Release：[v1.0.4](https://github.com/SaraiNoQ/web-knowledge-set/releases/tag/v1.0.4) 为 immutable、非 prerelease；资产为 `Zhiye_1.0.4_aarch64.dmg` 与 `SHA256SUMS`。
- DMG SHA-256：`8253bfc93cc8eb5707c830eb27c860dbd9b9f4f016ebe0e4dd438b9f700b1d46`；从线上 Release 下载后与 `SHA256SUMS` 复核一致。
- workflow 使用 `bundleVersion=10004`，应用代码签名为 ad-hoc；未使用 Developer ID、未公证且无更新通道。

## `1.0.3` Apple Silicon DMG

- 版本准备提交：`84b8fd90a0c7ae3ca416d5b52eb64e23aca55c37`；macOS workflow 兼容性修复提交：`43d0cb88823423440946643ba29cc2b805e09e46`。
- macOS desktop smoke：GitHub Actions run `32890233246` 成功完成 Rust/Tauri 编译、无签名应用构建、Chromium 安全边界、Keychain 和 URL/file 入口检查。
- DMG 构建：GitHub Actions run `32891612359` 成功完成版本断言、Apple Silicon 应用编译、ad-hoc 签名、DMG 封装、artifact 上传和 checksum 生成。
- 正式 Release：[v1.0.3](https://github.com/SaraiNoQ/web-knowledge-set/releases/tag/v1.0.3) 为 immutable；资产为 `Zhiye_1.0.3_aarch64.dmg` 与 `SHA256SUMS`，DMG SHA-256：`ff5190b12832b055d489e365d2972daa2b59800bcb0dece6856651d8484fb977`。
- DMG 内实际应用核验：`CFBundleShortVersionString=1.0.3`、`CFBundleVersion=10003`、Bundle ID `io.github.sarainoq.zhiye`、Apple Silicon `arm64`；签名为 ad-hoc，未使用 Developer ID、未公证且无更新通道。线上 Release 资产下载后 SHA256SUMS 复核通过。

## `1.0.2` Apple Silicon `.app`

- 最新桌面文章工作台构建提交：`db274450649547e7ada0c624e49994fc26e0cf06`；该提交已通过服务器门禁和最新 macOS desktop smoke。
- DMG 构建：GitHub Actions run `32875931607` 成功完成 Apple Silicon 应用编译、ad-hoc 签名、DMG 封装、artifact 上传和 checksum 生成。
- 最新 build Release：[v1.0.2-build.2](https://github.com/SaraiNoQ/web-knowledge-set/releases/tag/v1.0.2-build.2)；资产为 `Zhiye_1.0.2_aarch64.dmg` 与 `SHA256SUMS`，DMG SHA-256：`d605eff47fee590a3ab931937d720996e435a2d196c27aa18ac825b0f448a410`。
- DMG 内实际应用核验：`CFBundleShortVersionString=1.0.2`、`CFBundleVersion=10002`、Bundle ID `io.github.sarainoq.zhiye`、Apple Silicon `arm64`；签名为 ad-hoc，未使用 Developer ID、未公证且无更新通道。

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

### 前端：沉浸式文档管理（2026-10-04）

- 开发基线：`045c12c`（当次最新 `origin/main`），功能分支 `codex/immersive-workspace`；不涉及数据库迁移、Cloudflare 生产部署或 macOS 发布。
- `123.207.203.208:/root/dev/zhiye` 使用固定 Node `24.19.0` / pnpm `11.7.0`：冻结锁文件安装、`check`、`test`（205 通过，1 项按设计跳过）、`build`、`cloud:check`（42 通过）和两 Worker `cloud:bundle` dry-run 通过。
- 沉浸模式 Playwright 10 个用例通过，覆盖 1440/800/320px、侧栏收放、编辑器实例/未保存内容/光标/滚动、刷新记忆、指南和恢复模式、保存中的重复切换、失败通知、云端存储不可用、知识地图及论文译文草稿。通知曾遮挡退出按钮，已移到控制条下方并复验；新论文 fixture 在结束时清理，避免污染后续测试。
- 既有 `app.spec.ts` 联跑 27 个功能用例通过；侧栏用例在搜索控件的 `aria-valuetext` 断言失败（`e2e/app.spec.ts:351`）。在服务器独立目录从未修改的 `045c12c` 构建后复验，得到完全相同的失败；本次没有修改控件或该旧断言，不宣称全量 E2E 通过。
- 论文相关受影响用例再次联跑 4/4 通过（会话认证、新沉浸译文保留、既有论文导入/删除、阅读器内部滚动/缩放/分栏拖动）。本地 API 集成测试真实重开数据库并保留旧端口，证明随机新端口读取到已保存偏好；非法参数、未认证、跨来源和旧 data epoch 写入均被拒绝。
- 桌面与小屏 fixture 截图已检查；独立 diff 审查提出的小屏论文高度覆盖问题已修复：仅 ≥761px 的阅读区扣除控制条，≤760px 保留自然高度。增补 320px 宽、900/600px 高的上下两栏尺寸与滚动边界断言，等待响应式布局稳定后验证；再次通过 `check`、`build`、`cloud:bundle` 与论文联跑 4/4。独立复审通过，无剩余可执行发现。

### Cloudflare：沉浸、favicon 与扩展发布整合（2026-10-04）

- 沉浸提交 `f967a8b` 从当时 main `045c12c` 建立；该主线没有包含已上线的 favicon 修复，也没有原工作分支的 0.3.9 扩展修复。此次整合 `bc1e2ba` 的已审查扩展分支及 `6bf46a2` 的 favicon/扩展资产隔离，保留沉浸实现；不合入无关桌面版本更新。
- 指定服务器固定 Node `24.19.0` / pnpm `11.7.0`：冻结安装、类型检查、单元/集成测试（205 通过、1 项按设计跳过）、生产构建、Cloudflare 检查（42 通过）、Firefox AMO lint（0.3.9）与双 Worker dry-run 通过。沉浸、论文、favicon、X 原生正文的 Chromium/Firefox 发布回归 20/20 通过。
- 既有 0.3.9 签名 XPI 摘要为 `7fbe7aec14ec030fa46c7abe77b3442aa402dfbdd83643a5b64d04eee2e24b54`，最终构建后已通过暂存脚本的摘要、manifest、Mozilla 签名条目及构建内容逐字节校验。签名文件不进入 Git。
- 生产 D1 只读检查显示无待执行迁移；生产配置、D1/R2/Queue/Browser Run 绑定未改动。独立审查通过，无可执行发现；已合并原 favicon 分支历史并将 `94ddccd` 推送 main，两个 Worker 正式部署成功，版本及上线后访问边界证据记录在 `docs/CLOUDFLARE.md`。受 Access 登录和 Firefox 电脑控制权限限制，登录态 Web 读写、资源下载与真实扩展配对/剪藏尚未复验。

### 前端：知识库标题与视图切换微调（2026-10-05）

- 基线为当次最新 `origin/main` 的 `b53f052`，分支 `codex/library-view-control`。桌面顶部留白 32px → 11px，小屏 28px → 9px；篇数并入资料库信息行，标题右侧使用列表/节点双图标纸色切换器，地图页保留同款入口。仅用既有 Tooltip 与 CSS，无新增依赖、偏好或数据迁移。
- 指定服务器 Node `24.19.0` / pnpm `11.7.0` 冻结安装、类型检查、生产构建、Cloudflare 检查（42 项）与双 Worker dry-run 通过。完整单元/集成测试通过 `pnpm exec tsx --test --test-concurrency=1 tests/*.test.ts` 串行运行，205 通过、1 项按设计跳过；默认并行运行中既有 SIGKILL 恢复用例在服务关闭的 10 秒等待处失败，单独从未修改主线运行生命周期测试 4/4 通过，本次不修改该测试或服务源码。
- 相关 Chromium 联跑涵盖新控件、沉浸模式和既有地图节点阅读返回/视窗高度/语义筛选，共 16 项（含认证）。截图检查覆盖 1440/1000/800/320px 的普通及沉浸模式，标题与控件不重叠且无页面横向溢出；小屏篇数不换行。悬停、按压、键盘、减少动画、高对比度、回收站和反复切换均有回归断言。
- 联跑发现打开地图节点文档时不能因视图状态变化把焦点转到列表控件，否则提示层会吞掉第一次 Esc；已将列表焦点恢复限定在明确点击“返回列表”时，地图隐藏时关闭提示层。再次进入地图时等待按钮实际可见后聚焦，最多重试 12 帧且可取消，active 状态显式恢复可见性与交互。最终类型检查、生产构建、相关 Playwright 16/16 与双 Worker dry-run 通过；独立复审通过，无剩余可执行发现，诊断日志已移除。未发布桌面包。
- 用户另行授权生产部署后，已将提交 `112998bc6fd51fff2099d5a04add1ba73c39967c` 发布到两个 Cloudflare Worker，并校验、暂存现有 Firefox 0.3.9 签名 XPI。Web Version ID `1cb0e84b-0377-4f6c-ba68-041e31d41450`；Clip Version ID `c4c466d8-e046-4837-b7a9-b1564ce78bb5`。完整版本、绑定、迁移与上线边界记录见 `docs/CLOUDFLARE.md`；登录态读写、下载及真实扩展配对/剪藏本轮未验证。

### 前端：阅读中切换视图修复与切换器收紧（2026-10-05）

- 从已上线 UI 所在的 `e4e682d` 继续，分支 `codex/view-switch-reader-fix`；当次最新 main 仍为 `b53f052`，已包含在该基线中，避免遗漏上次尚未合入 main 的线上 UI。根因是按钮只设置 `graphMode`，但地图要求 `selectedId` 为空，导致目录隐藏且地图休眠。现在两个视图入口共用切换流程，先通过现有关闭/放弃确认，再清除文档选择并更新模式；论文译文未保存状态上报给同一确认保护，取消保留编辑。
- 控件视觉高度 52px → 34px（约减少三分之一），保留 44px 宽按钮、原图标与纸色动效；地图入口移到标题旁，篇数保留在右侧。更新 README 和知识地图说明，不新增依赖、存储字段或迁移。
- 指定服务器固定 Node `24.19.0` / pnpm `11.7.0`：冻结安装、类型检查、生产构建、串行完整单元/集成测试（205 通过、1 项按设计跳过）、云端测试（42 项）及双 Worker dry-run 通过。相关 Chromium 20/20 通过（含认证），覆盖本地及模拟云端的打开文章后切换、未保存正文取消/放弃、地图→阅读→地图→列表、论文译文取消/放弃、既有论文滚动/缩放/分栏与沉浸模式；320/800/1000/1440px 布局验证高度与位置，无新增横向溢出。桌面与小屏截图已检查。独立审查通过，无剩余可执行发现。用户另行授权后，提交 `491f4eacef84cd07e016e59798e323c1ea121e37` 已部署至两个生产 Worker，版本与访问边界见 `docs/CLOUDFLARE.md`；未发布桌面包。

### 前端：资料库信息行垂直居中（2026-10-05）

- 移除标题标签与篇数的顶部自对齐覆盖，沿用信息行的 flex 居中，使其与桌面侧栏收起按钮的中心一致，小屏仍使用居中规则。未更改行高、字体或视图切换逻辑。
- 指定服务器固定 Node 24.19.0 / pnpm 11.7.0：类型检查、生产构建、完整串行单元/集成（205 通过、1 项按设计跳过）、云端检查 42 项、双 Worker dry-run 及相关 Chromium 5/5 通过；320/800/1000/1440px 验证标签与篇数中心相对信息行误差不超过 1px。独立审查通过，无可执行发现。用户另行授权后，提交 `71afec661de0f9a4b5723eb2e29d4171a598a260` 已发布到两个生产 Worker；部署版本与访问边界见 `docs/CLOUDFLARE.md`。

## 2026-10-05 文档工作台外壳验收

- 分支：`codex/editor-workbench`，基于最新 `origin/main`，并沿用当前已部署的目录/阅读切换修复 `de810b4`。
- 统一纸色/朱红风格的 SVG 图标栏、紧凑目录、文档标签和位置栏；标签仅存在当前页面内存中，刷新后重新打开。返回目录保留标签；显式关闭当前标签选中相邻文章，关闭最后一篇回到目录；永久删除后移除相应标签。
- Node `24.19.0` / pnpm `11.7.0` 在 `123.207.203.208:/root/dev/zhiye` 运行；本地仅编辑、同步和查看服务器截图。
- `check`、`test`、`build` 通过；单元/集成测试 206 项，205 通过、1 项原有条件跳过、0 失败。Cloud API 测试包含在该套件中。
- Chromium 验证多文章切换/关闭、键盘方向键与 Home、取消关闭后正文和来源信息保留、返回目录保留标签、320/390px 窄屏、长文件夹名截断、390px 高横屏导航滚动、普通/沉浸模式工具栏不被标签覆盖。既有沉浸、目录悬停、资料库视图、地图、论文和 axe 无障碍回归通过。
- 主应用回归覆盖桌面运行时模拟、深链/文件导入、备份恢复、收藏/回收站/永久删除、修订、自动保存、编辑滚动、AI 流程；测试选择器现在区分目录按钮与标签按钮。编辑滚动用例显式保存后验证位置；Firefox 用例等待实际编辑器就绪后检查滚动容器。
- 独立审查发现并修复：标签栏遮挡工具栏、长文件夹名窄屏溢出、横屏导航底部入口不可达；复审确认解决且无新增可操作问题。
- 效果截图使用服务器 E2E 测试资料：[宽屏](assets/workspace-tabs.png)、[窄屏](assets/workspace-tabs-mobile.png)。截图不是线上用户数据。
- Firefox 专属项目验证主题滚动条及高对比度回退通过；`cloud:bundle` 的两个 Worker 干运行打包通过。
- 本次不包含 Cloudflare 生产部署或 macOS 安装包发布；平台共享前端验证不等同于原生发行验证。

## 2026-10-05 工作台导航与双主题优化

- 收藏、回收站、论文统一进入图标栏，目录收起完全隐藏；文章操作与来源信息同排，阅读大标题及面板按钮移除，目录菜单和面包屑支持修订保护的重命名。沉浸入口移至图标栏，顶部控制条移除。暖炭色主题涵盖阅读、编辑、地图与设置，偏好保存在站点存储。
- 指定服务器固定 Node 24.19.0 / pnpm 11.7.0：冻结安装、类型检查、生产构建、单元/集成 205 通过（1 项按设计跳过）、云端 42 通过。相关回归首轮 47 通过；旧沉浸断言修正后最终关键交互 16/16 通过（含认证），涵盖分类、彻底收起、双入口重命名、论文标题同步、沉浸布局/编辑状态保留、浅深色持久化及编辑器文字对比度。
- Firefox 0.3.9 AMO lint、既有签名 XPI 摘要与内容校验、双 Worker dry-run 均通过。未修改 D1 schema 或生产绑定。
- 独立审计发现的论文标题同步问题已修复并复验，最终审查无剩余可执行问题。按用户要求收敛测试范围，不做真实浏览器人工检查；生产登录态读写、扩展配对/剪藏及资产人工验收交由用户。此次不发布 macOS 安装包。
