export const READER_TOOL_STORAGE_BYTES = 64 * 1024;
export const READER_TOOL_STORAGE_VERSION = 1;
export interface ToolStorageBackend {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export type ToolStorageMigrations = Record<number, (values: Readonly<Record<string, unknown>>) => Record<string, unknown>>;
export class ToolStorageError extends Error {
  constructor(readonly code: "unavailable" | "invalid" | "future" | "migration" | "quota", message: string) { super(message); }
}
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
function object(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function keyValid(key: string) { return key.length > 0 && key.length <= 100 && !/[\u0000-\u001f\u007f]/u.test(key) && !["__proto__", "constructor", "prototype"].includes(key); }
function valuesValid(value: unknown): Record<string, unknown> {
  if (!object(value) || Object.keys(value).some((key) => !keyValid(key))) throw new ToolStorageError("invalid", "工具设置格式无效，原设置未被覆盖。");
  return value;
}
function json(value: unknown) {
  let text: string | undefined;
  try { text = JSON.stringify(value); } catch { throw new ToolStorageError("invalid", "工具设置必须是可保存的 JSON 数据。"); }
  if (text === undefined) throw new ToolStorageError("invalid", "工具设置不能保存空值或函数。");
  return text;
}

export function createReaderToolStorage(id: string, backend: ToolStorageBackend, schemaVersion = READER_TOOL_STORAGE_VERSION, migrations: ToolStorageMigrations = {}) {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(id) || !Number.isSafeInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > 100) throw new ToolStorageError("invalid", "工具存储版本无效。");
  const prefix = `zhiye.reader-tool.${id}.`, envelopeKey = `${prefix}$settings`;
  const read = () => {
    let raw: string | null, legacyKeys: string[] = [];
    try { raw = backend.getItem(envelopeKey); }
    catch { throw new ToolStorageError("unavailable", "浏览器暂时无法读取工具设置。"); }
    let version = 0, values: Record<string, unknown> = Object.create(null);
    if (raw !== null) {
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { throw new ToolStorageError("invalid", "工具设置已损坏，原设置未被覆盖。"); }
      if (!object(parsed) || Object.keys(parsed).some((key) => !["schemaVersion", "values"].includes(key)) || !Number.isSafeInteger(parsed.schemaVersion) || Number(parsed.schemaVersion) < 1) throw new ToolStorageError("invalid", "工具设置格式无效，原设置未被覆盖。");
      version = Number(parsed.schemaVersion);
      if (version > schemaVersion) throw new ToolStorageError("future", "此工具设置来自更新版本，请升级后再使用。");
      values = valuesValid(parsed.values);
    } else {
      try {
        for (let index = 0; index < backend.length; index += 1) { const key = backend.key(index); if (key?.startsWith(prefix) && key !== envelopeKey) legacyKeys.push(key); }
        for (const key of legacyKeys) {
          const name = key.slice(prefix.length);
          if (!keyValid(name)) throw new ToolStorageError("invalid", "旧版工具设置格式无效，原设置未被覆盖。");
          const value = backend.getItem(key);
          if (value !== null) values[name] = JSON.parse(value);
        }
      } catch (cause) {
        if (cause instanceof ToolStorageError) throw cause;
        throw new ToolStorageError("invalid", "无法读取旧版工具设置，原设置未被覆盖。");
      }
    }
    while (version < schemaVersion) {
      const migrate = migrations[version];
      if (migrate) values = valuesValid(migrate(Object.freeze({ ...values })));
      else if (version !== 0) throw new ToolStorageError("migration", "工具缺少设置升级路径，原设置未被覆盖。");
      version += 1;
    }
    const encoded = json({ schemaVersion, values });
    if (bytes(encoded) > READER_TOOL_STORAGE_BYTES) throw new ToolStorageError("quota", "此工具的全部设置超过 64 KiB，原设置未被覆盖。");
    return { values, legacyKeys };
  };
  return {
    get<T>(key: string, fallback: T): T {
      if (!keyValid(key)) throw new ToolStorageError("invalid", "工具设置名称无效。");
      try { const { values } = read(); return Object.hasOwn(values, key) ? values[key] as T : fallback; }
      catch (cause) { if (cause instanceof ToolStorageError && cause.code === "unavailable") return fallback; throw cause; }
    },
    set(key: string, value: unknown) {
      if (!keyValid(key)) throw new ToolStorageError("invalid", "工具设置名称无效。");
      const safeValue = JSON.parse(json(value)) as unknown;
      const { values, legacyKeys } = read();
      const encoded = json({ schemaVersion, values: { ...values, [key]: safeValue } });
      if (bytes(encoded) > READER_TOOL_STORAGE_BYTES) throw new ToolStorageError("quota", "此工具的全部设置超过 64 KiB，请先导出并整理术语。");
      // Write the complete envelope first; a failed write leaves every legacy setting intact.
      try { backend.setItem(envelopeKey, encoded); } catch { throw new ToolStorageError("unavailable", "工具设置未能保存，原设置仍然保留。"); }
      for (const key of legacyKeys) { try { backend.removeItem(key); } catch { /* The complete new envelope is already durable. */ } }
    },
  };
}
