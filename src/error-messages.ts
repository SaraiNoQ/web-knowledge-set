const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  UNAUTHORIZED: "本地会话已失效，请重新打开应用或当前启动地址。",
  ORIGIN_REJECTED: "请求来源未通过本地安全校验，请从织页窗口或受信地址重试。",
  LOCAL_SERVICE_UNREACHABLE: "无法连接本地织页服务，请确认服务仍在运行后重新打开。",
  MAINTENANCE: "正在维护或恢复本地数据，请稍候重试。",
  DATA_UNAVAILABLE: "当前数据暂不可用，请先完成恢复或重新打开应用。",
  DOCUMENT_UNAVAILABLE: "当前知识暂不可用，请先完成恢复或刷新页面。",
  STALE_DATA_EPOCH: "知识库已在恢复或维护中变化，请刷新页面后继续。",
  CLOUD_MAINTENANCE: "云端知识库正在恢复，请稍候刷新后继续。",
  DATA_CHANGED: "知识库已在其他操作中变化，请刷新后重试。",
  REQUEST_ABORTED: "操作已取消。",
  REQUEST_TOO_LARGE: "发送的内容超出安全大小限制，请缩小后重试。",
  RESPONSE_TOO_LARGE: "返回的内容超出安全大小限制，已停止处理。",

  INVALID_URL: "网页地址无效，请输入完整的 HTTP 或 HTTPS 地址。",
  BLOCKED_ADDRESS: "该地址指向不允许访问的网络范围，已在连接前阻止。",
  FETCH_TIMEOUT: "网页响应超时，请稍后重试。",
  UNSUPPORTED_CONTENT_TYPE: "该链接不是可支持的网页内容。",
  HTTP_ERROR: "网页返回错误，请确认链接可公开访问后重试。",
  EXTRACTION_EMPTY: "未能从网页中提取可用正文。",
  BROWSER_FAILED: "浏览器回退抓取失败，请稍后重试。",
  CAPTURE_CANCELLED: "网页抓取已取消。",
  RESTORE_INTERRUPTED: "云端恢复被中断，抓取任务已安全停止；请手动重试。",

  REVISION_CONFLICT: "这篇知识已在其他窗口修改，请基于最新版本重试。",
  FOLDER_NAME_CONFLICT: "已存在同名文件夹，请更换名称。",
  FOLDER_NOT_FOUND: "所选文件夹已不存在，请刷新后重试。",
  INVALID_FOLDER_ID: "所选文件夹无效或已被删除，请刷新后重试。",
  INVALID_FOLDER_NAME: "文件夹名称必须为 1 至 100 个字符。",
  DRAFT_CONFLICT: "草稿已在其他窗口修改，请选择要保留的版本。",
  DRAFT_EXISTS: "这篇知识已有未处理草稿，请先确认草稿。",
  DOCUMENT_CHANGED: "原知识在预览后发生了变化，请重新预览。",
  DERIVED_PREVIEW_STALE: "正文或 AI 设置在预览后发生了变化，请重新核对发送范围。",
  LLM_SETTINGS_CONFLICT: "AI 设置已在其他窗口更新，请重新打开设置。",

  INVALID_LLM_ENDPOINT: "AI 端点地址无效，请检查协议、主机和路径。",
  INVALID_LLM_SETTINGS: "AI 设置不完整或无效，请检查端点与模型。",
  INVALID_LLM_API_KEY: "API 密钥格式无效，请重新输入。",
  INVALID_LLM_TEST: "AI 连接测试设置无效，请检查端点、模型和本地信任选项。",
  LLM_DISABLED: "AI 派生知识当前已关闭，请先在 AI 设置中启用。",
  LLM_KEY_MISSING: "当前远程 AI 端点没有可用密钥，请先保存密钥。",
  LLM_KEY_STORAGE_FAILED: "浏览器无法保存或删除云端 AI 密钥，请检查站点存储权限后重试。",
  LLM_NOT_CONFIGURED: "所选 AI 端点尚未完成配置。",
  LLM_BUSY: "另一个 AI 任务正在运行，请等待完成后重试。",
  LLM_TASK_RUNNING: "当前 AI 任务仍在运行，无法重试。",
  LLM_STOPPING: "AI 任务正在安全停止，请稍后重试。",
  LLM_DNS_FAILED: "无法解析 AI 端点地址，请检查网络与地址。",
  LLM_TARGET_BLOCKED: "AI 端点指向不允许的网络地址，已阻止连接。",
  LLM_TLS_ERROR: "AI 服务器证书校验失败。请更换可安全连通的网络或 AI 平台；系统不会绕过证书校验。",
  LLM_NETWORK_ERROR: "无法连接 AI 端点，请检查网络与端点地址。",
  LLM_TIMEOUT: "AI 端点响应超时，请稍后重试。",
  LLM_REDIRECT_REJECTED: "AI 端点返回了不允许的重定向，已停止请求。",
  LLM_COMPRESSION_REJECTED: "AI 端点返回了不支持的压缩内容。",
  LLM_RESPONSE_TOO_LARGE: "AI 返回内容超出安全大小限制，已丢弃。",
  LLM_RESPONSE_TRUNCATED: "AI 返回的译文被模型截断，请缩短正文或更换支持更长输出的模型。",
  LLM_AUTH_FAILED: "AI 端点拒绝了密钥，请检查密钥与端点是否匹配。",
  LLM_RATE_LIMITED: "AI 端点暂时限流，请稍后重试。",
  LLM_HTTP_ERROR: "AI 端点返回错误，请检查模型名称和平台状态。",
  LLM_REQUEST_REJECTED: "AI 端点拒绝了请求格式，请检查平台是否兼容。",
  LLM_MODEL_REJECTED: "AI 端点不支持当前模型，请检查模型名称。",
  LLM_INVALID_PROBE: "AI 端点未返回预期的测试结果，请确认兼容性。",
  LLM_INVALID_RESPONSE: "AI 端点返回无效内容，请更换模型或平台后重试。",
  INVALID_CUSTOM_PROMPT: "AI 对话 Prompt 必须为 1–4,000 个字符，且不能包含控制字符。",
  LLM_INVALID_TRANSLATION: "AI 未按要求保留 Markdown 结构，本次翻译已丢弃，原文未改动。",
  LLM_SECRET_ECHO: "AI 返回内容包含敏感凭据，已丢弃该结果。",
  LLM_CANCELLED: "AI 任务已取消。",
  LLM_TRANSLATION_EMPTY: "正文中没有可翻译的 Markdown 文本。",
  LLM_TRANSLATION_TOO_LARGE: "正文超出当前完整翻译限制，请缩小文档后重试。",
  LLM_INTERNAL_ERROR: "AI 任务内部状态异常，请重新预览后再试。",

  BACKUP_FAILED: "完整留档创建失败，请检查存储空间后重试。",
  BACKUP_MISSING: "留档文件已不存在，无法继续校验或恢复。",
  BACKUP_NOT_FOUND: "未找到所选留档，请刷新列表。",
  BACKUP_TOO_LARGE: "留档超出当前安全大小限制。",
  BACKUP_ARCHIVE_REQUIRED: "请选择 .zhiye-backup 完整留档文件。",
  BACKUP_ARCHIVE_TOO_LARGE: "留档文件超过 2 GiB 安全上限，无法继续。",
  BACKUP_EXPORT_FAILED: "留档文件导出失败，请重新校验留档并检查存储空间。",
  BACKUP_IMPORT_FAILED: "留档文件导入失败，当前资料未更改，请检查文件后重试。",
  INVALID_BACKUP_ID: "留档标识无效，请刷新列表。",
  INVALID_BACKUP: "留档内容无效或不完整，已停止处理。",
  INVALID_BACKUP_ARCHIVE: "留档文件结构无效或已损坏，无法导入。",
  INVALID_BACKUP_EXPORT: "留档导出请求无效，请刷新列表后重试。",
  INVALID_BACKUP_IMPORT: "留档导入请求无效，请重新选择文件。",
  CONTENT_LENGTH_REQUIRED: "浏览器未提供留档文件大小，请重新选择文件后重试。",
  INVALID_CONTENT_LENGTH: "留档文件大小信息无效，请重新选择文件。",
  DUPLICATE_ZIP_PATH: "留档文件包含重复路径，已为保护数据停止导入。",
  UNEXPECTED_ZIP_ENTRY: "留档文件包含未知条目，已为保护数据停止导入。",
  ZIP_SYMLINK: "留档文件包含不允许的链接或非普通文件，已停止导入。",
  UNSUPPORTED_SCHEMA: "该留档由更新版本的织页创建，请升级应用后导入。",
  STAGING_SCHEMA_MISMATCH: "留档数据库版本与声明不一致，已停止恢复。",
  SPACE_CHECK_FAILED: "无法确认可用存储空间，为避免数据丢失已停止操作。",
  CHECKSUM_MISMATCH: "留档校验值不匹配，为避免损坏数据已停止恢复。",
  INSUFFICIENT_SPACE: "可用存储空间不足，请释放空间后重试。",
  UNSAFE_BACKUP_ROOT: "留档位置未通过安全校验，已停止操作。",
  UNSAFE_BACKUP_RECORD: "留档记录未通过安全校验，已停止操作。",

  ASSET_CACHE_FAILED: "图片离线保存失败，预览不会连接原站。",
  ASSET_INVALID: "离线图片内容无效，已停止读取。",
  ASSET_MAPPING_CHANGED: "离线图片记录已变化，请刷新后重试。",
  ASSET_MISSING: "离线图片文件已不存在。",
  ASSET_NOT_FOUND: "未找到所选离线图片。",
  ASSET_PATH_UNSAFE: "离线图片路径未通过安全校验。",
};

function safeCode(code: string | null | undefined) {
  const normalized = code?.trim().toUpperCase();
  return normalized && /^[A-Z0-9_]{1,80}$/u.test(normalized) ? normalized : "UNKNOWN_ERROR";
}

function familyMessage(code: string) {
  if (code.startsWith("LLM_")) return "AI 操作未完成，请检查设置、网络或模型后重试。";
  if (code.startsWith("INVALID_")) return "输入或操作参数无效，请检查后重试。";
  if (code.startsWith("UNSAFE_") || code.includes("PATH_UNSAFE")) return "内容未通过本地安全校验，已停止处理。";
  if (code.startsWith("UNSUPPORTED_")) return "不支持这种格式或内容，请改用受支持的输入。";
  if (code.endsWith("_NOT_FOUND") || code === "NOT_FOUND") return "目标不存在或已被移除，请刷新后重试。";
  if (code.endsWith("_CONFLICT") || code.endsWith("_CHANGED")) return "内容已在其他操作中变化，请刷新并重新确认。";
  if (code.endsWith("_TOO_LARGE") || code.endsWith("_LIMIT")) return "内容超出允许范围，请缩小规模后重试。";
  if (code.endsWith("_FAILED") || code.endsWith("_ERROR")) return "操作未完成，请稍后重试。";
  return null;
}

/** Convert a stable service code into safe, user-facing Chinese without exposing backend details. */
export function userErrorMessage(code?: string | null, status?: number) {
  const normalized = safeCode(code);
  const known = ERROR_MESSAGES[normalized];
  if (known) return known;
  const http = Number.isInteger(status) && Number(status) > 0 ? ` · HTTP ${status}` : "";
  const family = familyMessage(normalized);
  if (family) return `${family}（${normalized}${http}）`;
  return `操作未完成，请重试；若持续发生，请在诊断台查看错误码（${normalized}${http}）。`;
}

/** Keep structured codes, but deliberately discard arbitrary native or provider error text. */
export function userErrorFrom(cause: unknown, fallback: string) {
  if (cause && typeof cause === "object") {
    const value = cause as { code?: unknown; status?: unknown };
    if (typeof value.code === "string") {
      return userErrorMessage(value.code, typeof value.status === "number" ? value.status : undefined);
    }
  }
  return fallback;
}

export function isAbortError(cause: unknown) {
  return Boolean(cause && typeof cause === "object" && (cause as { name?: unknown }).name === "AbortError");
}
