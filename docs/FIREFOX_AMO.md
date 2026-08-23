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

权限说明：`activeTab` 只在用户点击“提取当前页面”后读取当前标签页；`scripting` 在当前页面执行本地正文提取器，并在保存后向已打开的织页页面发送刷新事件；`storage` 保存经配对获得的撤销型令牌；两个主机权限分别限定内容保存与织页页面刷新，不读取其他标签页。

数据声明：扩展在用户主动配对或确认保存时传输配对码/撤销型令牌（`authenticationInfo`）、来源 URL（`browsingActivity`）、网页正文（`websiteContent`），正文可能包含聊天或消息（`personalCommunications`）。不采集遥测、Cookie、历史、密码或支付数据；正文只发送到用户使用的 `clip.sarainoq.cn` 织页服务。

审核备注：扩展必须先在受 Cloudflare Access 保护的织页“帮助 → 浏览器扩展”生成一次性配对码。审核者可检查弹窗、提取预览和权限边界而无需测试账号；完整保存流程需要站点所有者提供的临时 Access 测试身份与配对码，提交前不得在仓库中保存这些凭据。

## 发布门禁

1. `pnpm check`、`pnpm test`、`pnpm build` 全部通过。
2. `pnpm firefox:amo` 通过；`web-ext 10.6.0 lint` 必须为 0 errors、0 notices，且只能出现 3 条已审查的 Defuddle 0.19.2 `UNSAFE_VAR_ASSIGNMENT` 警告（实体解码与 detached DOM 解析）。
3. 核对 manifest 版本、固定 ID、数据声明、隐私政策和源代码 ZIP。
4. 登录 [AMO Developer Hub](https://addons.mozilla.org/developers/)，选择 **On this site**，上传安装包和源代码包，填写页面资料并提交审核。
5. 只有 AMO 显示已签名/已发布版本后，才能把产品文档从“临时载入”改为正式安装链接。
