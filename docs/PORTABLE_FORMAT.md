# 织页便携知识包 v1

便携知识包是供其他工具读取、并可由织页重新导入的 ZIP 文件；它不是完整数据备份。

## 文件结构

```text
manifest.json
documents/<slug>-<short-id>.md
assets/<sha256>-<original-markdown-url-sha256>.<ext>
```

`manifest.json` 是 UTF-8 JSON，顶层字段为：

- `format`: 固定为 `zhiye-portable`。
- `version`: 固定为整数 `1`。
- `createdAt`: ISO 8601 时间。
- `documents`: 文档数组。

每个文档记录包含 `id`、`path`、`sha256`、`originalSha256`、标题、来源 URL、最终 URL、规范 URL、作者、发布时间、采集时间、标签、集合、收藏/归档状态、来源备注及 `assets`，并可包含 `folder`。`folder` 是一级文件夹名称字符串或 `null`，不表达嵌套层级或人工顺序；其他可空元数据使用 `null`，集合字段使用数组。

当前导出器始终写出 `folder`；旧 v1 包缺少该可选字段时仍可导入。新建或保留副本时，缺少 `folder` 与显式 `null` 都表示“未分类”；按来源更新现有文档时，缺少该字段保留原归属，显式 `null` 则移回“未分类”，字符串名称会复用或创建同名一级文件夹。单篇 Markdown 的 Front Matter 使用相同的可选 `folder` 字段和更新语义。

每个资源替换记录包含 `path`、`sha256`、`mimeType`、规范化后的缓存键 `sourceUrl`、Markdown 中的精确原值 `originalUrl` 和 `byteSize`。v1 只允许 JPEG、PNG、GIF、WebP 和 AVIF。导出的 Markdown 仅把已缓存的图片 URL 改写为相对资源路径；普通链接、代码和正文保持不变。重新导入时，正文用 `originalUrl` 恢复，资源映射按 `sourceUrl` 去重，并用 `originalSha256` 验证正文无损往返。

便携格式 v1 明确不包含 LLM 派生结果；它们只属于完整 SQLite 备份。单篇 Markdown 导出同样只包含人工正文和文档元数据，不附加派生结果。

## 校验与兼容

- 导入器必须先完整校验 ZIP 结构、路径、条目/解压大小、压缩比、声明文件和 SHA-256，再写入正式文档数据。
- ZIP 不得包含 manifest 未声明的文件、重复/绝对/父级路径、符号链接、加密条目、ZIP64 或多卷结构。
- v1 读取器必须拒绝未知的 `format` 或 `version`，不得猜测新格式。
- v1 内新增的 `folder` 等可选字段可被旧读取器忽略；改变既有字段语义、路径规则或校验方式必须提升 `version`。
- 未来版本应保留显式迁移入口；织页始终保证能导入自己当前版本导出的知识包。
