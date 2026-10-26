# 自研阅读工具

`runtime.ts` 是内置工具清单。新增模块后，在 `builtinReaderTools` 注册 manifest 和懒加载函数即可，无需把工具状态加入 `App.tsx`。

模块实现 `ReaderToolModule`，提供 command、selectionAction、Panel 和 Overlay 四个入口。`translation.tsx` 是完整示例。宿主统一处理选区校验、文档版本、命令、浮层位置、停用取消、异常隔离和自己的设置空间。组件中的流式结果保留在工具本身，按 80ms 合并刷新，不订阅整篇正文，也不逐段刷新 App。

工具通过 `ReaderToolApi` 获取已声明的能力：当前选区、选区翻译、私有设置、保存摘录。核心保管数据库、模型密钥、版本冲突和恢复后的 data epoch；工具不能拿到这些内部对象。新增宿主能力仍需修改宿主。

浮层由独立 Portal 挂到 body 的固定层。容器不拦截正文指针事件，只有工具窗口和选区按钮接收操作；原生模态框打开时隐藏浮层，关闭窗口或停用工具会取消请求。侧栏使用同一模块视图，正文无需插入工具 DOM。

内置模块仍属于可信代码；它们的 manifest 权限约束 SDK 调用，不构成恶意 JavaScript 的隔离边界。外部插件走独立的安装、执行和设置协议，不进入内置动态加载器。

摘录与人工关联属于核心数据。SQLite 完整备份和云端 v8 备份保留它们；本地 portable v3 随选中文章导出，连接只包含本次导出的两个端点。导入映射实际文档 ID，在正文导入的同一事务中写入，失败整体回滚；skip 保持目标记录，update 保留已有摘录并去重，copy 为新文档建立自己的摘录。论文云备份仍在云端恢复，现有桌面转换器明确拒绝论文包。

## 外部插件包

外部插件运行在可终止的 Worker 中，由宿主渲染有限的纯文本、输入项和按钮。插件不能添加 HTML、CSS、链接、iframe 或正文 DOM，也不能直接取得会话、模型密钥或原生接口。外部代码不在页面渲染线程执行；这仍属于浏览器边界，不是操作系统进程隔离。

包格式是**不压缩 ZIP**，仅接受 `manifest.json` 和一个 `.js` 文件。ZIP 和展开内容均不超过 1 MiB，脚本不超过 768 KiB，manifest 不超过 32 KiB。压缩文件、路径穿越、重复或大小写冲突文件、加密文件、链接、未声明资源和哈希不符的包会被拒绝。无需依赖或安装脚本；若使用其他开发依赖，应先打成单个自包含脚本。

manifest 示例：

```json
{
  "schemaVersion": 1,
  "hostApiVersion": 1,
  "id": "example.selection",
  "name": "选区查看示例",
  "version": "1.0.0",
  "storageVersion": 1,
  "publisher": { "name": "Example", "origin": "https://example.com" },
  "permissions": ["selection.read"],
  "entry": "main.js",
  "files": { "main.js": "构建时写入入口文件的64位小写SHA256" }
}
```

发布者字段是包作者的声明，**没有经过身份或签名认证**。安装与每次升级都要由用户确认完整包指纹、发布者来源和权限；文件哈希只能证明内容一致，不能证明代码可信。升级不能复用上一版批准。

`main.js` 可使用冻结的全局 `zhiye`：

```js
const actions = [{ id: "inspect", label: "查看当前选区" }];
zhiye.render({ text: "选中文字后，点击查看。", fields: [], actions });
zhiye.onAction(async (actionId) => {
  if (actionId !== "inspect") return;
  const current = await zhiye.selection();
  zhiye.render({ text: current?.selection.anchor.quote || "当前没有选区。", fields: [], actions });
});
```

SDK 方法：

| 方法 | 用途及权限 |
| --- | --- |
| `selection()` | 异步取得当前选区及短期 token，需 `selection.read` |
| `capabilities()` | 异步查询平台、宿主版本和已批准权限 |
| `storage.get(key, fallback = null)` / `storage.set(key, value)` | 异步读写本插件私有 JSON，需 `storage.own` |
| `translate(token, language, onText?)` | 请求宿主翻译选区并接收文本片段，需 `translation.request` |
| `saveExcerpt(token, translation = "", note = "")` | 把当前版本的选区保存为核心摘录，需 `annotations.create` |
| `render({text, fields, actions})` | 更新宿主视图；最多 4 个输入项和 4 个按钮 |
| `onAction(callback)` | 接收 `callback(actionId, values)`，输入值仍需插件自身校验 |
| `close()` | 关闭工具并取消活动任务 |

字段格式为 `{id, label, value, multiline?}`，按钮格式为 `{id, label}`。所有显示值都按纯文本处理。不能把选区 token 替换为任意文档 ID 或正文；文档版本变化、停用和卸载都会使旧请求失效。

在已有项目依赖环境中，可用以下构建脚本生成可导入包：

```js
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
const script = readFileSync("main.js");
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
manifest.files = { [manifest.entry]: createHash("sha256").update(script).digest("hex") };
writeFileSync("selection-tool.zip", zipSync({
  "manifest.json": strToU8(JSON.stringify(manifest)),
  [manifest.entry]: script
}, { level: 0 }));
```

包和私有设置保存在当前浏览器，总计最多 4 MiB，每个插件设置最多 64 KiB；不随核心知识库备份自动迁移，请使用插件导出/恢复入口。恢复包会重新校验并要求授权，所有恢复的插件保持停用，运行检查通过后再启用。停用保留设置；卸载时可以选择保留或删除自己的设置。

升级先暂存并检查，失败可恢复前一版代码和升级前设置快照。手动回退也会恢复该快照，升级后新增的私有设置应先导出。私有设置同时绑定插件 ID 和发布者来源；相同 ID 改用不同来源时，也必须先导出并明确清理旧设置，避免新作者读取旧数据。首版只接受相同 `storageVersion` 的升级；设置结构不兼容时拒绝自动迁移，要求先备份、卸载并清理设置后单独安装。
