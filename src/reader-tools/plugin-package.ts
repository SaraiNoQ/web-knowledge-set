export const PLUGIN_PACKAGE_BYTES = 1024 * 1024;
export const PLUGIN_STATE_BYTES = 4 * 1024 * 1024;
export const PLUGIN_PERMISSIONS = ["selection.read", "translation.request", "storage.own", "annotations.create"] as const;
export type PluginPermission = typeof PLUGIN_PERMISSIONS[number];
export interface PluginManifest {
  schemaVersion: 1;
  hostApiVersion: 1;
  id: string;
  name: string;
  version: string;
  storageVersion: number;
  publisher: { name: string; origin: string };
  permissions: PluginPermission[];
  entry: string;
  files: Record<string, string>;
}
export interface VerifiedPluginPackage {
  manifest: PluginManifest;
  sha256: string;
  script: string;
  archive: string;
}
export class PluginPackageError extends Error {}
const invalid = (message = "插件包格式无效，原插件未被修改。"): never => { throw new PluginPackageError(message); };
const text = new TextDecoder("utf-8", { fatal: true });
const utf8 = new TextEncoder();
const hashPattern = /^[a-f0-9]{64}$/u;
export const pluginIdValid = (value: unknown): value is string => typeof value === "string" && /^[a-z][a-z0-9-]{0,31}\.[a-z][a-z0-9-]{0,31}$/u.test(value);
export function pluginObject(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) return invalid();
  return value as Record<string, unknown>;
}
function plain(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) return invalid();
  return value;
}
const pathValid = (name: string) => name.length <= 120 && /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/u.test(name) && name.split("/").every((part) => part !== "" && part !== "." && part !== "..") && !name.includes("\\");
export function parsePluginManifest(value: unknown): PluginManifest {
  const v = pluginObject(value, ["schemaVersion", "hostApiVersion", "id", "name", "version", "storageVersion", "publisher", "permissions", "entry", "files"]);
  if (v.schemaVersion !== 1 || v.hostApiVersion !== 1) return invalid("插件需要不受支持的宿主协议版本。");
  if (!pluginIdValid(v.id)) return invalid("插件 ID 必须使用 publisher.tool 命名空间。");
  const name = plain(v.name, 80), version = plain(v.version, 40);
  if (!/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/u.test(version) || !Number.isSafeInteger(v.storageVersion) || Number(v.storageVersion) < 1 || Number(v.storageVersion) > 100) return invalid();
  const publisher = pluginObject(v.publisher, ["name", "origin"]), publisherName = plain(publisher.name, 100), origin = plain(publisher.origin, 300);
  let parsedOrigin: URL; try { parsedOrigin = new URL(origin); } catch { return invalid(); }
  if (parsedOrigin.protocol !== "https:" || parsedOrigin.origin !== origin || parsedOrigin.username || parsedOrigin.password) return invalid("发布者来源必须是完整 HTTPS origin，且不含路径或凭据。");
  if (!Array.isArray(v.permissions) || v.permissions.length > PLUGIN_PERMISSIONS.length || v.permissions.some((permission) => !PLUGIN_PERMISSIONS.includes(permission as PluginPermission)) || new Set(v.permissions).size !== v.permissions.length) return invalid("插件申请了不受支持或重复的权限。");
  const entry = plain(v.entry, 120);
  if (!pathValid(entry) || !entry.endsWith(".js")) return invalid();
  const files = v.files;
  if (!files || typeof files !== "object" || Array.isArray(files)) return invalid();
  const entries = Object.entries(files);
  if (entries.length !== 1 || entries.some(([path, hash]) => path !== entry || !hashPattern.test(String(hash)) || typeof hash !== "string") || !Object.hasOwn(files, entry)) return invalid("插件包只能包含声明并校验哈希的入口脚本，不接受 HTML、CSS 或其他资源。");
  return { schemaVersion: 1, hostApiVersion: 1, id: v.id, name, version, storageVersion: Number(v.storageVersion), publisher: { name: publisherName, origin }, permissions: [...v.permissions] as PluginPermission[], entry, files: Object.fromEntries(entries) as Record<string, string> };
}
export async function pluginSha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export function pluginArchiveBytes(archive: string): Uint8Array {
  if (typeof archive !== "string" || archive.length > Math.ceil(PLUGIN_PACKAGE_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(archive)) return invalid();
  try { return Uint8Array.from(atob(archive), (char) => char.charCodeAt(0)); } catch { return invalid(); }
}
function encodeArchive(bytes: Uint8Array): string {
  let raw = ""; for (let start = 0; start < bytes.length; start += 16_384) raw += String.fromCharCode(...bytes.subarray(start, start + 16_384));
  return btoa(raw);
}
const crcTable = Array.from({ length: 256 }, (_, value) => { for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; return value >>> 0; });
function crc32(bytes: Uint8Array) { let value = 0xffffffff; for (const byte of bytes) value = crcTable[(value ^ byte) & 255]! ^ (value >>> 8); return (value ^ 0xffffffff) >>> 0; }
function archiveEntries(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  const minimum = Math.max(0, bytes.length - 65_557);
  while (end >= minimum && view.getUint32(end, true) !== 0x06054b50) end -= 1;
  if (end < minimum || end + 22 > bytes.length || end + 22 + view.getUint16(end + 20, true) !== bytes.length) return invalid();
  const count = view.getUint16(end + 10, true), centralSize = view.getUint32(end + 12, true), centralStart = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0 || view.getUint16(end + 8, true) !== count || count !== 2 || centralStart + centralSize !== end) return invalid("插件 ZIP 必须只包含 manifest.json 和一个脚本。");
  let cursor = centralStart, total = 0;
  const entries = new Map<string, { size: number; crc: number; start: number }>(), lowerNames = new Set<string>(), ranges: Array<[number, number]> = [];
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) return invalid();
    const flags = view.getUint16(cursor + 8, true), method = view.getUint16(cursor + 10, true), compressed = view.getUint32(cursor + 20, true), size = view.getUint32(cursor + 24, true);
    const nameSize = view.getUint16(cursor + 28, true), extra = view.getUint16(cursor + 30, true), comment = view.getUint16(cursor + 32, true), local = view.getUint32(cursor + 42, true), fileMode = view.getUint32(cursor + 38, true) >>> 16;
    if (cursor + 46 + nameSize + extra + comment > end || flags & 1 || [compressed, size, local].includes(0xffffffff) || view.getUint16(cursor + 34, true) !== 0 || (fileMode & 0xf000) !== 0 && (fileMode & 0xf000) !== 0x8000 || size > PLUGIN_PACKAGE_BYTES) return invalid("插件 ZIP 包含不支持的文件、加密内容或超限压缩数据。");
    // Stored ZIP entries make the expansion budget independent of untrusted size headers.
    if (method !== 0 || compressed !== size) return invalid("首版插件包仅支持不压缩 ZIP，请按 SDK 示例打包。");
    let name: string; try { name = text.decode(bytes.subarray(cursor + 46, cursor + 46 + nameSize)); } catch { return invalid(); }
    if (!pathValid(name) || lowerNames.has(name.toLowerCase()) || local + 30 > centralStart || view.getUint32(local, true) !== 0x04034b50) return invalid("插件 ZIP 含重复文件或不安全路径。");
    const localNameSize = view.getUint16(local + 26, true), localExtra = view.getUint16(local + 28, true), dataStart = local + 30 + localNameSize + localExtra;
    if (dataStart + compressed > centralStart || view.getUint16(local + 6, true) !== flags || view.getUint16(local + 8, true) !== method) return invalid();
    try { if (text.decode(bytes.subarray(local + 30, local + 30 + localNameSize)) !== name) return invalid(); } catch { return invalid(); }
    const range: [number, number] = [local, dataStart + compressed];
    if (ranges.some(([start, stop]) => range[0] < stop && range[1] > start)) return invalid();
    ranges.push(range); lowerNames.add(name.toLowerCase()); entries.set(name, { size, crc: view.getUint32(cursor + 16, true), start: dataStart }); total += size;
    if (total > PLUGIN_PACKAGE_BYTES) return invalid("插件展开后超过 1 MiB。");
    cursor += 46 + nameSize + extra + comment;
  }
  if (cursor !== end || !entries.has("manifest.json") || entries.get("manifest.json")!.size > 32_768) return invalid();
  return entries;
}
export async function stagePluginPackage(input: Uint8Array): Promise<VerifiedPluginPackage> {
  if (!(input instanceof Uint8Array) || input.byteLength < 22 || input.byteLength > PLUGIN_PACKAGE_BYTES) return invalid("插件 ZIP 不能超过 1 MiB。");
  const bytes = Uint8Array.from(input), entries = archiveEntries(bytes);
  const files = Object.fromEntries([...entries].map(([name, info]) => [name, bytes.subarray(info.start, info.start + info.size)]));
  for (const [name, info] of entries) if (!files[name] || files[name]!.length !== info.size || crc32(files[name]!) !== info.crc) return invalid("插件文件校验失败。");
  let raw: unknown; try { raw = JSON.parse(text.decode(files["manifest.json"]!)); } catch { return invalid("插件 manifest.json 无法读取。"); }
  const manifest = parsePluginManifest(raw), expected = ["manifest.json", ...Object.keys(manifest.files)];
  if (entries.size !== expected.length || expected.some((name) => !entries.has(name))) return invalid("插件 ZIP 含未声明的文件。");
  for (const [name, hash] of Object.entries(manifest.files)) if (await pluginSha256(files[name]!) !== hash) return invalid("插件声明的文件哈希与实际内容不符。");
  let script: string;
  try { script = text.decode(files[manifest.entry]!); } catch { return invalid("插件脚本必须使用 UTF-8。"); }
  if (!script.trim() || utf8.encode(script).byteLength > 768 * 1024) return invalid("插件脚本超过限额。");
  return { manifest, sha256: await pluginSha256(bytes), script, archive: encodeArchive(bytes) };
}
