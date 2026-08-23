织页剪藏 Firefox AMO 源代码构建说明

环境
- Ubuntu 24.04 LTS（x64 或 ARM64）
- Node.js 24.19.0
- pnpm 11.7.0
- 全部构建工具均为 package.json / pnpm-lock.yaml 锁定的开源本地工具；不调用网页构建服务。

Node.js 安装：从 https://nodejs.org/download/release/v24.19.0/ 获取对应平台官方包，或让 nvm/fnm 读取源代码包根目录的 .node-version。pnpm 由 Node 自带的 Corepack 安装。

构建
1. corepack enable
2. corepack prepare pnpm@11.7.0 --activate
3. pnpm install --frozen-lockfile
4. pnpm firefox:amo

第 4 步会通过 npm exec 下载并运行精确版本 web-ext 10.6.0，仅用于 Mozilla lint；它不参与生成 content.js、popup.js 或 ZIP。

审核产物
- 安装包：dist/extensions/zhiye-clipper-firefox.zip
- 可展开目录：dist/extensions/zhiye-clipper-firefox/

安装包中的 content.js 与 popup.js 由 Vite 本地打包、压缩；未混淆，不下载或执行远程代码。ZIP 由 fflate 0.8.3 生成。

Mozilla web-ext 10.6.0 校验预期为 0 errors、0 notices、3 warnings。三条 UNSAFE_VAR_ASSIGNMENT 均来自锁定的 Defuddle 0.19.2：textarea.innerHTML 用于 HTML 实体解码，template.innerHTML / div.innerHTML 用于脱离文档的片段解析。输入是当前页面克隆，扩展会先删除 script、表单和可编辑区域；这些脱离文档的节点不执行脚本，最终只输出用户核对的 Markdown。完整依赖与锁文件包含在本源代码包中，供审核者复查。
