# Firefox AMO 发布说明

## 产物

在锁定的 Node.js 24.19.0 与 pnpm 11.7.0 环境中运行：

```sh
pnpm install --frozen-lockfile
pnpm firefox:amo
```

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

- 固定 ID `clipper@zhiye.sarainoq.cn`；自签名产物按 `<加载项编号>-<版本>.xpi` 命名，文件名里的 `3058733` 是 AMO 加载项编号，实际版本以包内 `manifest.json` 为准。每次以 `web-ext 10.6.0` 对编译目录 `dist/extensions/zhiye-clipper-firefox`（而非源代码 ZIP）执行 **unlisted** 自签名。
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
