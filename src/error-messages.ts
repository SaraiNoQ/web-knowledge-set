const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  UNAUTHORIZED: "本机会话已失效，请重新打开织页。",
  ORIGIN_REJECTED: "访问来源未通过检查，请从织页重试。",
  LOCAL_SERVICE_UNREACHABLE: "无法连接本机服务，请重新打开织页。",
  MAINTENANCE: "正在维护或恢复资料，请稍后重试。",
  DATA_UNAVAILABLE: "资料暂不可用，请恢复或重新打开。",
  DOCUMENT_UNAVAILABLE: "织片暂不可用，请恢复或刷新页面。",
  STALE_DATA_EPOCH: "知识库已变化，请刷新后继续。",
  CLOUD_MAINTENANCE: "云端正在恢复资料，请稍后刷新。",
  DATA_CHANGED: "知识库已变化，请刷新后重试。",
  REQUEST_ABORTED: "操作已取消。",
  REQUEST_TOO_LARGE: "内容超出大小限制，请缩小后重试。",
  RESPONSE_TOO_LARGE: "返回内容过大，已停止处理。",

  INVALID_URL: "链接不完整，请输入完整网页地址。",
  BLOCKED_ADDRESS: "不允许访问这个网络地址，已阻止连接。",
  FETCH_TIMEOUT: "网页响应太慢，请稍后重试。",
  UNSUPPORTED_CONTENT_TYPE: "暂不支持这个链接中的内容。",
  HTTP_ERROR: "网页打不开，请确认无需登录。",
  EXTRACTION_EMPTY: "没找到正文，可以改用手动摘录。",
  BROWSER_FAILED: "收取网页失败，请稍后重试。",
  CAPTURE_CANCELLED: "网页收取已取消。",
  RESTORE_INTERRUPTED: "云端恢复中断，收取已停止。请手动重试。",

  REVISION_CONFLICT: "其他窗口已修改，请查看最新版本。",
  FOLDER_NAME_CONFLICT: "分组名称重复，请换个名称。",
  FOLDER_NOT_FOUND: "分组已不存在，请刷新后重试。",
  INVALID_FOLDER_ID: "分组无效或已删除，请刷新后重试。",
  INVALID_FOLDER_NAME: "分组名称须为1至100个字符。",
  DRAFT_CONFLICT: "草稿有两个版本，请选择保留哪个。",
  DRAFT_EXISTS: "这张织片已有草稿，请先确认草稿。",
  DOCUMENT_CHANGED: "织片已变化，请重新预览。",
  DERIVED_PREVIEW_STALE: "正文或设置已变化，请重新核对发送内容。",
  LLM_SETTINGS_CONFLICT: "智能设置已在别处更新，请重新打开。",

  INVALID_LLM_ENDPOINT: "服务地址无效，请检查完整地址。",
  INVALID_LLM_SETTINGS: "智能设置有误，请检查地址和模型。",
  INVALID_LLM_API_KEY: "API Key 格式无效，请重新输入。",
  INVALID_LLM_TEST: "请检查地址、模型和本机信任选项。",
  LLM_DISABLED: "助手未开启，请先到设置中开启。",
  LLM_KEY_MISSING: "缺少平台密钥，请先保存密钥。",
  LLM_KEY_STORAGE_FAILED: "无法保存或删除密钥，请检查浏览器权限。",
  LLM_NOT_CONFIGURED: "所选服务尚未设置完成。",
  LLM_BUSY: "助手正在处理其他任务，请稍候。",
  LLM_TASK_RUNNING: "当前任务仍在处理，请稍候再试。",
  LLM_STOPPING: "正在停止任务，请稍后重试。",
  LLM_DNS_FAILED: "找不到服务地址，请检查网络和地址。",
  LLM_TARGET_BLOCKED: "不允许访问这个服务地址，已阻止连接。",
  LLM_TLS_ERROR: "服务安全检查未通过。请更换网络或平台，不会跳过检查。",
  LLM_NETWORK_ERROR: "无法连接服务，请检查网络和地址。",
  LLM_TIMEOUT: "服务响应太慢，请稍后重试。",
  LLM_REDIRECT_REJECTED: "服务跳转地址不安全，已停止请求。",
  LLM_COMPRESSION_REJECTED: "暂不支持服务返回的数据格式。",
  LLM_RESPONSE_TOO_LARGE: "返回内容过大，已丢弃结果。",
  LLM_RESPONSE_TRUNCATED: "译文不完整，请缩短正文或更换模型。",
  LLM_AUTH_FAILED: "密钥未通过，请检查平台和密钥。",
  LLM_RATE_LIMITED: "请求过于频繁，请稍后重试。",
  LLM_HTTP_ERROR: "服务出错，请检查模型和平台状态。",
  LLM_REQUEST_REJECTED: "服务不接受本次请求，请检查兼容性。",
  LLM_MODEL_REJECTED: "服务不支持这个模型，请检查名称。",
  LLM_INVALID_PROBE: "连接测试未通过，请确认服务兼容。",
  LLM_INVALID_RESPONSE: "返回内容无效，请更换模型或平台。",
  INVALID_CUSTOM_PROMPT: "问题须为1至4,000个字符，不能含控制字符。",
  LLM_INVALID_TRANSLATION: "译文格式有误，已丢弃。原文保留。",
  LLM_SECRET_ECHO: "结果含敏感凭据，已丢弃。",
  LLM_CANCELLED: "生成已取消。",
  LLM_TRANSLATION_EMPTY: "正文中没有可翻译的文字。",
  LLM_TRANSLATION_TOO_LARGE: "正文超过翻译上限，请缩短后重试。",
  LLM_INTERNAL_ERROR: "任务状态异常，请重新预览后重试。",

  SEMANTIC_KEY_MISSING: "请先保存 SiliconFlow 推荐密钥。",
  SEMANTIC_AUTH_FAILED: "推荐密钥未通过，处理已暂停。请更新密钥并测试。",
  SEMANTIC_RATE_LIMITED: "推荐请求过于频繁，将稍后自动重试。",
  SEMANTIC_NETWORK_ERROR: "无法连接推荐服务，将稍后自动重试。",
  SEMANTIC_PROVIDER_UNAVAILABLE: "推荐服务暂不可用，将稍后自动重试。",
  SEMANTIC_REDIRECT_REJECTED: "推荐服务跳转不安全，已停止请求。",
  SEMANTIC_INVALID_RESPONSE: "推荐结果无效，本次关联未发布。",
  SEMANTIC_INPUT_TOO_LARGE: "这段内容仍无法处理，可稍后手动重试。",
  SEMANTIC_SETTINGS_CONFLICT: "推荐设置已在别处更新，请重新打开。",
  SEMANTIC_MODEL_CHANGE_REQUIRES_PAUSE: "请先暂停处理，再更换推荐模型。",
  SEMANTIC_KEY_STORAGE_FAILED: "无法保存或删除推荐密钥，请检查权限。",

  BACKUP_FAILED: "完整备份创建失败，请检查剩余空间。",
  BACKUP_MISSING: "备份文件已不存在，无法检查或恢复。",
  BACKUP_DELETE_PENDING: "备份尚未删完，请再次删除。",
  BACKUP_NOT_FOUND: "未找到所选备份，请刷新列表。",
  BACKUP_TOO_LARGE: "备份超出大小限制。",
  BACKUP_ARCHIVE_REQUIRED: "请选择 .zhiye-backup 备份文件。",
  BACKUP_ARCHIVE_TOO_LARGE: "备份超过 2 GiB，无法继续。",
  BACKUP_EXPORT_FAILED: "下载备份失败，请检查备份和剩余空间。",
  BACKUP_IMPORT_FAILED: "导入失败，当前资料未更改。请检查文件。",
  INVALID_BACKUP_ID: "备份编号无效，请刷新列表。",
  INVALID_BACKUP: "备份无效或不完整，已停止处理。",
  INVALID_BACKUP_ARCHIVE: "备份格式有误或已损坏，无法导入。",
  INVALID_BACKUP_EXPORT: "下载请求无效，请刷新后重试。",
  INVALID_BACKUP_IMPORT: "导入请求无效，请重新选择文件。",
  CONTENT_LENGTH_REQUIRED: "无法获取文件大小，请重新选择文件。",
  INVALID_CONTENT_LENGTH: "文件大小信息无效，请重新选择文件。",
  DUPLICATE_ZIP_PATH: "备份内有重复文件路径，已停止导入。",
  UNEXPECTED_ZIP_ENTRY: "备份内有未知文件，已停止导入。",
  ZIP_SYMLINK: "备份含不允许的文件类型，已停止导入。",
  UNSUPPORTED_SCHEMA: "备份来自新版织页，请先升级应用。",
  STAGING_SCHEMA_MISMATCH: "备份的数据版本不一致，已停止恢复。",
  SPACE_CHECK_FAILED: "无法确认剩余空间，已停止操作。",
  CHECKSUM_MISMATCH: "备份检查未通过，已停止恢复。",
  INSUFFICIENT_SPACE: "空间不足，请清理后重试。",
  UNSAFE_BACKUP_ROOT: "备份位置不安全，已停止操作。",
  UNSAFE_BACKUP_RECORD: "备份记录未通过检查，已停止操作。",

  ASSET_CACHE_FAILED: "图片未存到本机，预览不访问原站。",
  ASSET_INVALID: "本机图片无效，已停止读取。",
  ASSET_MAPPING_CHANGED: "图片记录已变化，请刷新后重试。",
  ASSET_MISSING: "本机图片文件已不存在。",
  ASSET_NOT_FOUND: "未找到所选本机图片。",
  ASSET_PATH_UNSAFE: "图片位置未通过安全检查。",
};

function safeCode(code: string | null | undefined) {
  const normalized = code?.trim().toUpperCase();
  return normalized && /^[A-Z0-9_]{1,80}$/u.test(normalized) ? normalized : "UNKNOWN_ERROR";
}

function familyMessage(code: string) {
  if (code.startsWith("LLM_")) return "生成未完成，请检查设置、网络或模型。";
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
  return `操作未完成，请重试；若持续发生，请在问题排查查看错误码（${normalized}${http}）。`;
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
