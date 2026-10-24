# 织页 Web / 桌面性能优化实施总结

日期：2026-10-24。交付为本地代码和提交，未推送、创建PR、合并或部署，未接触真实用户数据库。

## 版本与范围

- 仓库：SaraiNoQ/web-knowledge-set；默认分支main。实施前检查远端HEAD与本地均为 `1a6eb0500c07d14da40b289bdd66e0e3d1f74934`，工作区干净。
- 工作分支：`codex/performance-optimization`，仓库路径 `/workspace/web-knowledge-set`。
- 独立基线worktree：`/workspace/performance-baseline`，detached于上述审计SHA。
- 代码提交：
  - `2aee56d4c502b7742ccca935d598f129d332cfd5`：云端合并分页、预算受限解压、备份预检。
  - `5c72b2fbe4cda487d5040cccaed1c7fa457d5dde`：目录分页/渲染隔离、长文门槛、启动维护与关闭协调、静态缓存。
  - `b6ea62b452fe5d750fc8cf6573a70179ffc5f3cd`：有界trigram候选与字面查询回退。
- 上述提交仅存在本地，不提供假定已可访问的GitHub提交链接。报告/基准与结果作为随后独立本地提交交付，最终SHA见交付消息。
- 已按AGENTS.md开展独立审查；用户明确授权本地实施、提交、正常测试依赖安装。本任务没有外部发布授权，也未执行发布。

## 已完成与具体边界

| 审计项 | 实现 | 定位 | 验收与剩余边界 |
|---|---|---|---|
| F1 P1 | 每个目录分支仅加载并渲染当前30条，前/后页替换，轮询只刷新当前页；末页缩小时回退有效页 | `src/components/LibraryDirectory.tsx` loadBranch/pagination | 有界分页代替复杂虚拟化；最多6展开分组加未分组。分页/键盘/跨页选择E2E已写，浏览器受阻未执行 |
| F2 P1 | memo目录，筛选对象和事件回调稳定，回调使用最近已提交状态；跨页批量操作文案明确包含其他页 | `src/App.tsx` useStableCallback/directoryFilters；LibraryDirectory | 静态复审通过；尚无React Profiler实测，不宣称输入耗时降低具体百分比 |
| F3 P1 | 云Web和桌面阅读同样遵守250k字符长文暂停，用户显式开启 | `src/App.tsx` longPreviewAllowed及阅读分支 | 覆盖原先绕过分支。手动开启后仍全文解析，不是增量Markdown渲染 |
| S1 P1部分 | 本地title/body搜索用现有FTS单3gram探测，最多257候选；<=256才使用候选，超出回原扫描；完整原谓词复核，论文页保留 | `server/db.ts:3356`起 | 无数据库迁移；中文短词、标点、大小写、NUL、排序、分页、更新后索引回归通过。默认all/source、云搜索、论文扫描及摘录N+1未改 |
| D1 P1 | 监听前建立维护锁，READY后执行原历史备份全校验和当日备份；UI先显示维护等待，轻量鉴权startup-status不做全库诊断 | `server/index.ts`；`server/app.ts:1625,3270`；`src/App.tsx`；shared StartupStatus | 不删除强校验。解决普通启动维护占用READY等待预算；不等于可编辑时间缩短。迁移前/恢复前校验仍在READY前，不能称所有20秒超时已消除 |
| D3 P1部分 | 备份copy/fsync改异步，文件→目录→验证→rename→父目录持久化顺序不变；关闭先标记，维护结束不会新启排队任务 | `server/backup.ts` createBackup；`server/app.ts` beginShutdown | 维护期写入仍受控，关闭等待SQLite存活回归通过。DatabaseSync仍存在，不宣称完全消除事件循环阻塞 |
| W1 P1 | 正常UUID库由SQL UNION合并排序分页，仅结果页最多30行跨D1边界；共享筛选builder避免复制语义 | `cloud/worker.ts:356`起；cloud/extension.ts、capture.ts | 现有混合列表及新跨页oracle通过。非canonical导入ID/非标准日期退回旧比较器以保语义；该兼容路径仍有旧成本。SQL COUNT/OFFSET仍有规模成本，不声称rows_read恒定 |
| W2 P1 | central directory只读预检预算，增量解压逐块验证实际大小/累计预算，按声明大小单buffer写入，异常发生在DB/R2写入前 | `cloud/backup.ts:542`起 | 超限、伪造大小、截断、重复与旧恢复兼容回归通过。96MiB是解压输出预算，不是Worker总RSS上限；压缩输入、JSON对象仍驻留 |
| W3 P2部分 | 备份先COUNT，超过32条直接拒绝，不先读全部正文；保留后续权威检查 | `cloud/backup.ts` createArchive | >32条拒绝及恢复原子性通过；8MiB论文JSON流式快照未做 |
| L1 P2 | 仅实际存在的hash构建资源使用private immutable长缓存；HTML、非版本资源和SPA缺失资源fallback保持no-store | `server/app.ts:1262`起；tests/static-cache.test.ts | HEAD、新旧hash、fallback、安全头与业务API鉴权回归通过。无跨随机端口重启缓存收益承诺 |

## 安全与独立审查

没有弱化鉴权、维护锁、迁移前/恢复前校验、恢复原子性或关闭数据保护；未增加新依赖、未更换架构、未修改schema migration。

独立审查发现并修正：

1. 长FTS短语在重复正文上出现昂贵位置交集；最终采用单3gram+有界探测/回退。
2. 云SQL排序对任意导入ID不同于原localeCompare；增加兼容回退和原算法oracle。
3. 维护结束可能在关闭过程中重新启动采集；增加关闭标志与排队任务回归。
4. 首屏等待若调用完整data-safety会再次扫描全库；改为轻量鉴权startup-status，安全面板仍保留完整检查。
5. 初始化错误页无法关闭、关闭在途重试可能挂载新编辑器；通过原服务端close-ready等待维护，并在关闭待确认期间禁用重试，匹配超时/失败后释放。

搜索、云恢复、桌面生命周期及前端静态复审最终无剩余阻断项；这不替代缺失的浏览器/真机测试。

## 验证结果

环境：Debian 13.6 Linux x86_64；Node24.19.0；Corepack pnpm11.7.0；Xeon Platinum8573C；可见5CPU、cgroup4核/16GiB。无Rust/macOS环境。初始依赖复用审计环境。

| 检查 | 结果 |
|---|---|
| `pnpm check`（前端/server/test/extension/cloud五项TypeScript） | 最终通过 |
| `pnpm build` | 最终通过；包含服务、Vite和浏览器扩展 |
| 全部 `tests/*.test.ts`，单文件并发度1 | **234项：233通过，1失败**；不伪称全绿 |
| 唯一失败：动态页面使用真实sandboxed Chromium | 缺浏览器时回退http，断言期望browser；未修改基线worktree同项同样失败 |
| 官方 `playwright install chromium` | CDN `403 Domain forbidden`；工具内部尝试后退出1，未换镜像/路线绕过 |
| 新增7项performance-boundaries E2E及更新已有E2E | TypeScript/静态审查通过；**未执行浏览器** |
| 原生桌面/macOS WebView/安装包 | **未运行**，无适用环境；未用Linux冒充 |
| 云端完整专项 | 50/50通过，已包含于全量测试 |
| 本地数据库专项 | 新增后完整37项通过；后续300条候选预算回归亦包含于最终全量测试 |
| policy/cloudflare-delivery `.test.mjs` | 25/25通过 |
| Wrangler两个example配置 `deploy --dry-run` | 均通过，只构建，未部署 |
| `git diff --check` | 通过 |
| 独立lint命令 | 项目没有lint脚本；未新增任意lint工具，使用项目完整check与diff校验 |

前端错误页关闭的最后修改已纳入最终check/build；新增搜索回退已纳入最终全量测试。浏览器阻碍未被跳过标记掩盖。

## 性能A/B：方法与结果

同一容器，基线worktree与候选均使用相同Node/锁定依赖。所有测试/build结束后再串行运行，未与其他基准并行。每次子进程180秒上限，所有基准正常退出，无超时。每份测试数据都在独立临时目录，完成后清理。

补充基准沿用审计方法：1k/10k篇，每篇8460字符/9900 UTF-8字节加编号；查询预热1次后15次，p95为nearest-rank（在15次时等于最大值）；5次同步未命中查询测timer延后；约195MB数据库，1/2/3份历史备份巡检各3次。正文重复度高，适合发现高命中回退；没有论文、附件与真实用户分布。单轮小样本，不用于推广整体SLA。

### 最终10k正文基准

| 操作 | 基线median / p95 ms | 最终median / p95 ms |
|---|---:|---:|
| 最近列表 | 34.11 / 44.96 | 30.65 / 35.44 |
| 标题查询 | 272.81 / 316.19 | 271.86 / 308.87 |
| 高命中正文 | 178.97 / 226.34 | 178.20 / 183.17 |
| 未命中正文 | 154.21 / 165.22 | 11.52 / 13.77 |
| 中文高命中 | 177.68 / 185.76 | 179.17 / 185.72 |
| 深页列表 | 38.86 / 42.49 | 39.36 / 45.34 |

五次同步未命中查询造成timer延后：**752.18 → 61.86ms**。未命中查询在该负载中明显改善；高命中保留原扫描，未复现首版放大；中文和深页有小幅变慢，不隐藏。未优化路径的小差异不能归因于本次改动。该timer不是UI输入延迟。

首版候选方案被否决：10k高命中正文median约997.16ms，对应当轮基线221.28ms。原始输出保留为 `rejected-first-candidate-audit.json`，不是最终版本。最终改为最多257候选的单trigram探测，避免完整posting list与长短语位置交集放大。完整字面查询仍是最终判定。

1/2/3份备份巡检median基线935.82/1931.18/2789.15ms，最终960.00/1891.22/3022.82ms；3份最大值2819.25→3467.93ms。**未减少校验工作量，也不宣称校验吞吐改善。** 启动改造的收益是READY与可见维护阶段分离和异步I/O，真机启动/交互指标仍待测。

### 仓库现有基准（相同方法串行执行）

| 指标 | 基线 | 候选 |
|---|---:|---:|
| 10,100条库recent p95 | 4.16ms | 3.67ms |
| 英文搜索p95（默认all路径未改） | 15.65ms | 15.01ms |
| 中文搜索p95（默认all路径未改） | 18.80ms | 17.59ms |
| 1MiB写入p95 | 87.02ms | 102.19ms |
| 1MiB读取p95 | 1.71ms | 2.45ms |
| 99MiB附件便携导出，单次 | 1905.86ms | 1908.20ms |
| 便携导入，单次 | 585.22ms | 606.07ms |
| 1000节点×1024维元数据，单次 | 27.8ms | 34.9ms |
| 全图算法，单次 | 944.6ms | 1169.4ms |
| 逐条追加算法，单次 | 4652.0ms | 5397.9ms |

以上基准各退出0；图算法和上述默认all查询未在本轮优化，结果仅回归/波动记录，不主张收益。最后搜索调整只影响title/body，因此不为该调整重复运行不变的all/地图路径。逐条追加没有5秒断言，不能把5397.9ms写成测试失败。全文写入、地图等变慢值已保留；单次/小样本不能区分宿主抖动与真实回退，后续应多轮交替复测。

包体：审计主JS1627.86kB/gzip515.00kB；最终1631.11kB/gzip515.85kB。为新增边界处理略增，**本轮没有完成分包或包体缩减**。PDF、地图原有动态加载仍保留。

## 操作与复现

用户可观察到：目录每组有上一页/下一页；跨页选择保留且批量操作覆盖所有已选；长文阅读需手动打开预览；桌面普通启动维护时先显示等待，完成后进入工作台。维护页关闭不会强杀维护，错误页可走既有安全关闭流程。

无需迁移数据或改配置。不要将测试指向真实库。使用独立路径或新工作区复现：

```sh
# 仓库根；本环境缓存路径只是为可写性配置，不改变HOME。
export PNPM_HOME=/workspace/.pnpm
export XDG_DATA_HOME=/workspace/.local
export COREPACK_HOME=/workspace/.corepack
corepack pnpm install --frozen-lockfile --store-dir /workspace/.pnpm-store
corepack pnpm check
corepack pnpm build
node_modules/.bin/tsx --test --test-concurrency=1 tests/*.test.ts
node --test tests/delivery-policy.test.mjs tests/cloudflare-delivery.test.mjs

# 先在基线worktree生成dist-server，依赖可复用相同锁文件安装。
# 两次命令串行执行，不与test/build一起运行。
node scripts/benchmark-performance-audit.mjs /workspace/performance-baseline
node scripts/benchmark-performance-audit.mjs /workspace/web-knowledge-set

# 下列在各自worktree根分别串行执行。
node_modules/.bin/tsx scripts/benchmark-library.ts
node_modules/.bin/tsx scripts/benchmark-knowledge-map.ts

# 浏览器可用后执行；在共享开发服务器仍遵守仓库E2E锁脚本。
# 本任务未运行以下浏览器命令：
PLAYWRIGHT_BROWSERS_PATH=/workspace/playwright-browsers \
  node_modules/.bin/playwright test e2e/performance-boundaries.spec.ts \
  e2e/unified-workspace.spec.ts e2e/app.spec.ts e2e/immersive.spec.ts --project=chromium
```

新增基准脚本仅使用合成临时库并在finally清理。基线和最终原始JSON、被否决候选数据、命令退出状态合并在 `performance-optimization-results.json`；更完整日志可随ZIP交付。Git是代码主来源，不把node_modules、dist、数据库、凭据或截图打入交付ZIP。

## 尚未实施/验证

| 项目 | 保留原因及下一步 |
|---|---|
| D2 P1原生数据目录迁移可见页/专用线程 | Rust/macOS不可验证，涉及迁移恢复高风险；保留原同步安全流程，待受支持runner和中断/磁盘满回归 |
| S1剩余默认all/source、D1检索投影、论文摘录N+1 | 要覆盖中文短词/跨字段/论文块语义并验证D1能力与迁移，不能仓促替换；本轮只交付可验证局部候选优化 |
| F3进一步分块/worker解析、F4增量大纲 | 浏览器无运行条件；当前仅统一已有保护，不冒险改AST/source-offset语义 |
| F5按需分包、D4桌面依赖裁剪 | 需Coverage、首次打开延迟和.app实物验证；不以警告阈值掩盖主包 |
| F6全应用轮询统一、F7地图聚合 | 本轮仅目录轮询有界；其他轮询、地图层级和布局需要交互/规模测试 |
| W3完整流式快照、W4论文页窗口/Range、W5语义分块缓存 | 涉及API、缓存失效/epoch，未作未经验证的大范围重构 |
| D5大文件IPC流、本地导出流式化 | 已有二进制IPC与上限；先需真实多进程RSS证明，不以猜测副本数改权限通道 |
| macOS冷启动/RSS、WebView、浏览器交互、真实D1/Worker资源 | 未测；浏览器官方CDN403、Rust/macOS缺失，未换路径绕过，也未拿Linux数据代替 |

本轮是已实施、可追溯的关键瓶颈改进，不声称审计全部问题已解决。没有发布操作。
