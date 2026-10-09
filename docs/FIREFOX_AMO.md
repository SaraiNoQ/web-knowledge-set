# Firefox AMO 发布说明

## 产物

当前 Firefox / Chrome 发布目标为 `0.3.10`，仅更新扩展弹窗文案，权限、数据声明和剪藏逻辑不变。线上仍是已签名的 `0.3.9`；签名 `0.3.10` XPI 并部署 Cloudflare 前，不应把源码版本描述为已发布。

`0.3.9` 原因与回归：0.3.8 的容器判定只接受 `.x-article-body`，会在 Defuddle 已有的 `XArticleExtractor` 运行之前拒绝原生 `twitterArticleReadView` / `twitterArticleRichTextView`。仅放行容器仍不够：后续公式/控件清理会删除 `contenteditable="false"` 的 Draft.js 阅读正文。服务器 Firefox 与 Chromium 均复现原“正文尚未加载”错误；单独修正识别后，Firefox 复现提取结果仅剩封面图片。修复仅在选定 X 正文克隆内保留只读内容，继续删除可编辑输入、表单和按钮；在清理之后验证真实正文，再复用 Defuddle 原生解析器。回归覆盖帖子/文章 ID 不同、独立阅读视图、推荐与回复隔离以及只有表单/控件的空正文。

原生解析器的 `canExtract()` 只要求 `twitterArticleRichTextView`；已补充没有 `twitterArticleReadView` 外壳时从当前帖子或正文父容器定位的分支。此分支同样已在 Firefox 复现外壳缺失导致的原报错。封面与正文按范围保存，兼容原生解析器把同一 twimg 封面从 `name=medium` 升级为 `name=large`，避免混合 schema/原生结构重复添加封面。

`0.3.9` 原实现构建门禁：服务器 Node 24.19.0 / pnpm 11.7.0 冻结安装、`check`、`test`、`build`、`cloud:check`（42 通过）、`firefox:amo`、`cloud:bundle` 全部通过；单元门禁保留 Linux root 环境下既有 Chromium 沙箱用例跳过。11 项浏览器检查通过（3 项 Firefox 原生阅读器、7 项 Chromium 提取及 1 项认证边界），包括旧版 X、ChatGPT 公式与懒加载图片回归；`web-ext 10.6.0 lint` 为 0 errors、0 notices，仅有 3 条已审查的 Defuddle 依赖警告。独立代理审查完整差异后无可操作问题。

证据边界：本次内置浏览器可读 Hanako 示例的公开 `.x-article-body` 页面；原生阅读器回归结构来自已锁定的 Defuddle 0.19.2 解析器契约。用户 Firefox 的电脑控制权限未开放，尚不能声称已在该用户的登录态页面完成实际剪藏。

`0.3.8` 构建门禁：服务器 Node 24.19.0 冻结安装、`check`、`test`（204 通过、1 跳过）、`build`、`cloud:check`、`cloud:bundle`、`firefox:amo` 与 5 项提取浏览器测试通过，独立审查无可操作问题。新用例按 Hanako 示例实际 DOM 覆盖无 schema 的帖子页、直达页、纯文本及 ID 不匹配，旧逻辑已复现相同空正文错误；原页面 DOM 在内置浏览器中可读，服务器浏览器加载该真实页面未出现正文并超时，因此不把服务器真实链接提取记为成功。

在锁定的 Node.js 24.19.0 与 pnpm 11.7.0 环境中运行：

```sh
pnpm install --frozen-lockfile
pnpm firefox:amo
```

发布当前新版本时，在干净、已提交的源码工作区运行 `bash scripts/sign-firefox-unlisted.sh`。脚本会安装锁定依赖、构建并校验扩展，然后在终端中隐藏地提示 AMO API Key 与 Secret，使用 `web-ext 10.6.0` 执行 unlisted 签名。密钥只在脚本进程环境中使用，不写入文件、命令行参数或 Git。完成后脚本会核对 XPI 的 AMO 签名和包内容，并输出签名文件路径、SHA-256 与 Chrome ZIP 路径。将 SHA-256 写入 `extension/amo/signed-release.json`，再按发布门禁提交；签名 XPI 放在 `/tmp` 等 Git 与 `dist/` 之外的位置。

提交 AMO 的安装包是 `dist/extensions/zhiye-clipper-firefox.zip`；选择“需要提交源代码”，同时上传 `dist/extensions/zhiye-clipper-firefox-source.zip`。源代码包根目录的 `README.txt` 给出审核者可重复执行的构建步骤。

## AMO 页面资料

- 名称：织页剪藏
- 摘要：把当前已登录网页转换为可核对的 Markdown，并保存到你的织页云端知识库。
- 类别：Other；Productivity
- 许可证：MIT
- 支持网站：`https://github.com/SaraiNoQ/web-knowledge-set`
- 隐私政策：`https://github.com/SaraiNoQ/web-knowledge-set/blob/main/docs/PRIVACY.md`

权限说明：`activeTab` 只在用户点击“提取当前页面”后读取当前标签页；`scripting` 在当前页面执行本地正文提取器，并在保存后向已打开的织页页面发送刷新事件；`storage` 保存经配对获得的撤销型令牌，以及用户可选填写的云端 AI 密钥；两个主机权限分别限定内容保存与织页页面刷新，不读取其他标签页。

数据声明：扩展在用户主动配对或确认保存时传输配对码/撤销型令牌（`authenticationInfo`）、来源 URL（`browsingActivity`）、网页正文（`websiteContent`），正文可能包含聊天或消息（`personalCommunications`）。弹窗的“AI 标题”默认关闭：只有用户勾选并填入自己的云端 AI 密钥后，该密钥才随剪藏请求发给 `clip.sarainoq.cn` 用于生成中文标题，取消勾选会立即清除本地密钥。不采集遥测、Cookie、历史、密码或支付数据；正文只发送到用户使用的 `clip.sarainoq.cn` 织页服务。

审核备注：扩展必须先在受 Cloudflare Access 保护的织页“帮助 → 浏览器扩展”生成一次性配对码。审核者可检查弹窗、提取预览和权限边界而无需测试账号；完整保存流程需要站点所有者提供的临时 Access 测试身份与配对码，提交前不得在仓库中保存这些凭据。

## 签名记录

- `0.3.9` · 扩展源码 `bc1e2ba` · 2026-10-04 核验服务器既有 `/root/amo-signed/3058733-0.3.9.xpi`，SHA-256 `7fbe7aec14ec030fa46c7abe77b3442aa402dfbdd83643a5b64d04eee2e24b54`。在整合沉浸模式与 favicon、完成最终 `build` 和 `firefox:amo` 后，`scripts/stage-firefox-xpi.mjs` 已严格通过整包摘要、当前 manifest、Mozilla 签名条目及五个扩展文件的逐字节一致校验；签名文件未进入 Git。本条记录现有产物核验，不表示重新签名；生产分发状态以 Cloudflare 部署记录为准。

- 固定 ID `clipper@zhiye.sarainoq.cn`；自签名产物按 `<加载项编号>-<版本>.xpi` 命名，文件名里的 `3058733` 是 AMO 加载项编号，实际版本以包内 `manifest.json` 为准。每次以 `web-ext 10.6.0` 对编译目录 `dist/extensions/zhiye-clipper-firefox`（而非源代码 ZIP）执行 **unlisted** 自签名。
- `0.3.8` · 扩展源码提交 `bde9c388dd96ceafaf8c7c5f78346d6f43c834a3` · 所有者的 `web-ext sign --channel=unlisted` 返回 `/root/amo-signed/3058733-0.3.8.xpi`，已下载到用户本机；服务器对该 AMO 产物计算 SHA-256 为 `0197d786d96e249b3d658d18c84226d581e1ae56450be23831b5bea588801b6c`，包内 manifest 为 `0.3.8`，固定 ID 与权限不变。该版本补充公开页面无 schema 结构，未包含 0.3.9 的原生阅读器修复；本记录不表示其已部署到 Cloudflare。
- `0.3.7` · 扩展源码提交 `e139299` · `web-ext 10.6.0 sign --channel=unlisted` 返回 `3058733-0.3.7.xpi`，SHA-256 `4ed2d8c7e36c794a4b802d58d41d81471c4e29dcb1104349b2ec6dfa99575bd3`；包内 manifest 为 `0.3.7`，固定 ID 与权限不变。该摘要来自 AMO 返回的签名产物，`scripts/stage-firefox-xpi.mjs` 核对整包摘要和当前构建的五个扩展文件后暂存为 `dist/extensions/zhiye-clipper-firefox.xpi`。线上分发地址：`https://zhiye.sarainoq.cn/extensions/zhiye-clipper-firefox.xpi?v=0.3.7`（Web Version ID `990ca7ef-f5aa-4436-a283-0945b5d3e7cb`）；未登录时 Access 返回 302，登录态下载待复验。不在仓库记录签名凭据或 XPI。
- `0.3.6` · 源码提交 `f69a673` · 门禁：`check`、`test`（204 通过、1 跳过）、`build`、`cloud:check`（42 通过）、`cloud:bundle`、`firefox:amo` 全部通过；`web-ext 10.6.0 lint` 为 0 errors、0 notices，仅剩 3 条已审查的 Defuddle 0.19.2 `UNSAFE_VAR_ASSIGNMENT` 警告（`content.js`）。产物 `3058733-0.3.6.xpi`，SHA-256 `dcad3ad35b37d414fc49e75d14f729327362d0b6b889f9946c92e47e692d1bab`。复核：包内 `manifest.json` 为 `0.3.6`、固定 ID 与 `strict_min_version` 不变，打包后的 `content.js` 含懒加载占位符判定，`META-INF/` 含 5 项 cose/rsa 签名文件；同一目录内 `0.3.5` 产物的 SHA-256 与上一条记录一致。本版首次带上 `3d5e591` 的懒加载占位图修复。`zhiye-web` 已重新部署，帮助页下载链接与线上扩展包均为 `0.3.6`（Version ID `c5525d9d-1093-4d34-94a7-35cfca6b92cf`）。
- `0.3.5` · 源码提交 `f85345d` · 门禁：`check`、`test`（153 通过、1 跳过）、`build`、`cloud:check`（28 通过）、`cloud:bundle`、`firefox:amo` 全部通过；`web-ext 10.6.0 lint` 为 0 errors、0 notices，仅剩 3 条已审查的 Defuddle 0.19.2 `UNSAFE_VAR_ASSIGNMENT` 警告。产物 `3058733-0.3.5.xpi`，SHA-256 `7db319267ab54c7c1a8a6451219fc382a06d3172cb1398fd20675ae7603a8c88`。复核：包内 `manifest.json` 为 `0.3.5`，`popup.html` 含 `ai-panel`，打包后的 `popup.js` 含 `AI 标题未生成` 分支、仅在有密钥时写入存储的最努力持久化，以及提交时读取输入框的密钥，`META-INF/` 含 cose/rsa 签名文件。
- `0.3.4` · 源码提交 `8cf7246` · 门禁：`pnpm check`、`pnpm test`（148 通过、1 跳过）、`pnpm build`、`pnpm firefox:amo` 通过。产物 `3058733-0.3.4.xpi`，SHA-256 `1f24cba7d36502ab10f6e078b8a138a97f65c7a0d876965299c91d9cc089aff9`。
- 签名产物必须存放于 `dist/` **之外**（例如 `/root/amo-signed/`）：`pnpm build` 会清空 `dist/`，放在里面的 `.xpi` 会在下一次构建时丢失。已签名的版本不可重签（AMO 拒绝重复版本），只能从 API 重新取回：`GET /api/v5/addons/addon/clipper@zhiye.sarainoq.cn/versions/<版本>/`（unlisted 需 JWT，下载 `file.url` 也要带同一个 JWT）。
- 该 XPI 属自签名产物，不进 Git，仓库也不记录任何 AMO 凭据；安装包由所有者自行分发。
- 线上帮助页下载签名 XPI 前，记录成功的 AMO unlisted 签名运行及其返回 XPI 的 SHA-256；在最终 `pnpm build` 和 `pnpm firefox:amo` 后运行 `node scripts/stage-firefox-xpi.mjs <AMO 签名 XPI 路径> <已记录的 SHA-256>`。脚本先核对整包摘要，再核对 manifest、签名条目及五个扩展文件与当前构建逐字节一致，复制到 `dist/extensions/zhiye-clipper-firefox.xpi`；重新构建后必须重新暂存，绝不把未签名 ZIP 改后缀发布。
- 待补：（可选）在 AMO Developer Hub 以 “On this site” 提交审核 `zhiye-clipper-firefox.zip` + `zhiye-clipper-firefox-source.zip`，通过后再把产品文档改为正式安装链接。

## 发布门禁

1. `pnpm check`、`pnpm test`、`pnpm build` 全部通过。
2. `pnpm firefox:amo` 通过；`web-ext 10.6.0 lint` 必须为 0 errors、0 notices，且只能出现 3 条已审查的 Defuddle 0.19.2 `UNSAFE_VAR_ASSIGNMENT` 警告（实体解码与 detached DOM 解析）。
3. 核对 manifest 版本、固定 ID、数据声明、隐私政策和源代码 ZIP。
4. 登录 [AMO Developer Hub](https://addons.mozilla.org/developers/)，选择 **On this site**，上传安装包和源代码包，填写页面资料并提交审核。
5. 只有 AMO 显示已签名/已发布版本后，才能把产品文档从“临时载入”改为正式安装链接。
