# 织页

织页是单用户、本机运行的互联网知识库：输入公开网页 URL，静态抓取优先，正文不足时回退到 Chromium；结果以可编辑 Markdown 保存到 SQLite，并提供标签、全文搜索、预览和单篇导出。

## 开发约束

本地目录只编辑和同步源码。依赖安装、构建、测试与开发服务全部在 `root@campus-server:/root/dev/zhiye` 完成；详细规则见 [AGENTS.md](./AGENTS.md)。

服务器使用固定 Node `24.19.0`：

```sh
npx -y node@24.19.0 /usr/lib/node_modules/corepack/dist/pnpm.js install --frozen-lockfile
npx -y node@24.19.0 /usr/lib/node_modules/corepack/dist/pnpm.js check
npx -y node@24.19.0 /usr/lib/node_modules/corepack/dist/pnpm.js test
npx -y node@24.19.0 /usr/lib/node_modules/corepack/dist/pnpm.js test:e2e
```

启动远端开发服务时固定一个远端 localhost 端口：

```sh
KB_PORT=4173 KB_DATA_DIR=/root/dev/zhiye/.data npx -y node@24.19.0 /usr/lib/node_modules/corepack/dist/pnpm.js dev
```

需要从本机浏览器访问时，另开终端建立 SSH 隧道：

```sh
ssh -L 4173:127.0.0.1:4173 root@campus-server
```

然后访问 `http://127.0.0.1:4173`。服务不会监听局域网地址。

## 数据与桌面端

- SQLite 是唯一事实源；网页快照位于数据目录的 `snapshots/`。
- 生产服务启动后会输出一次性 `ZHIYE_READY` 地址，用它换取本地会话 Cookie。
- Tauri 外壳、sidecar 资源和 Chromium 可在服务器准备并做 Linux 编译检查。
- 未签名 macOS `.app` 必须在具备 Apple SDK 的 macOS 构建环境生成；当前 Linux 服务器不能交叉产出该包。
