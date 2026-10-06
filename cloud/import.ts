import type { ImportApplyItem, ImportApplyResult, ImportPreview, ImportStrategy } from "../shared/types";
import type { PreparedImportItem } from "../shared/types";
import { ImportParseError, parseImportRequest } from "../shared/import";
import { CloudHttpError, jsonObject, unsafeControl, type D1Database } from "./extension";

type Payload = Extract<PreparedImportItem["payload"], { type: "markdown" }>;
interface Item { id: string; item_index: number; label: string; source_url: string; payload_json: string; existing_id: string | null; existing_revision: number | null; error: string | null; warnings_json: string; result_json: string | null }

export async function handleImportApi(request: Request, db: D1Database, url: URL, epoch: string) {
  if (!url.pathname.startsWith("/api/imports/")) return null;
  const now = Date.now();
  if (url.pathname === "/api/imports/preview" && request.method === "POST") {
    const body = await jsonObject(request, 12 * 1024 * 1024);
    if (body.kind !== "markdown") throw new CloudHttpError(400, "INVALID_IMPORT", "云端当前支持 Markdown 文件导入，请选择 Markdown。");
    let parsed: PreparedImportItem[];
    try { parsed = parseImportRequest("markdown", body); }
    catch (cause) { if (cause instanceof ImportParseError) throw new CloudHttpError(400, cause.code, cause.message); throw cause; }
    if (!parsed.length) throw new CloudHttpError(400, "INVALID_IMPORT", "请至少选择一个 Markdown 文件。");
    const id = crypto.randomUUID();
    const createdAt = new Date(now).toISOString();
    const items: ImportPreview["items"] = [];
    const statements = [db.prepare("DELETE FROM cloud_import_batches WHERE expires_at < ?").bind(now), db.prepare("INSERT INTO cloud_import_batches(id, epoch, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(id, epoch, createdAt, now + 3600_000)];
    const seen = new Map<string, { id: string; revision: number }>();
    for (const [index, item] of parsed.entries()) {
      const payload = item.payload as Payload;
      const path = (body.files as { path: string }[])[index].path;
      const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(path)))].map((value) => value.toString(16).padStart(2, "0")).join("");
      const source = payload.sourceUrl || `zhiye://article/${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
      const aliases = [source, payload.finalUrl, payload.canonicalUrl];
      const existing = await db.prepare("SELECT id, revision FROM cloud_documents WHERE kind='article' AND deleted_at IS NULL AND (source_url IN (?, ?, ?) OR final_url IN (?, ?, ?) OR canonical_url IN (?, ?, ?)) ORDER BY created_at, id LIMIT 1").bind(...aliases, ...aliases, ...aliases).first<{ id: string; revision: number }>() ?? aliases.map((alias) => alias && seen.get(alias)).find(Boolean) as { id: string; revision: number } | undefined;
      const itemId = crypto.randomUUID();
      const warnings = [...item.warnings];
      if (payload.tags.length || payload.collections.length || payload.folder || payload.archivedAt || payload.capturedAt) {
        warnings.push("云端暂不写入部分组织属性，完整 Front Matter 已保留在正文中。");
        payload.markdown = (body.files as { content: string }[])[index].content;
      }
      const contentError = !payload.title.trim() || payload.title.length > 1000 || payload.sourceNote.length > 50_000 || [payload.title, payload.markdown, payload.sourceNote, payload.author || ""].some((value) => unsafeControl.test(value)) ? "正文或来源信息包含非法控制字符，或标题/备注超出长度上限。" : null;
      const error = item.error || contentError || (new TextEncoder().encode(JSON.stringify(payload)).byteLength > 1024 * 1024 ? "单篇内容超过云端 1 MiB 上限，请拆分文件。" : null);
      if (!error) for (const alias of aliases) if (alias && !seen.has(alias)) seen.set(alias, existing || { id: itemId, revision: 1 });
      statements.push(db.prepare("INSERT INTO cloud_import_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)").bind(itemId, id, index, item.label, source, error ? "{}" : JSON.stringify(payload), existing?.id ?? null, existing?.revision ?? null, error, JSON.stringify(warnings)));
      items.push({ id: itemId, index, label: item.label, sourceUrl: payload.sourceUrl, existingDocumentId: existing?.id ?? null, status: error ? "invalid" : existing ? "duplicate" : "valid", error, warnings });
    }
    await db.batch!(statements);
    return { body: { id, kind: "markdown", status: "preview", createdAt, counts: { total: items.length, valid: items.filter((item) => item.status === "valid").length, duplicate: items.filter((item) => item.status === "duplicate").length, invalid: items.filter((item) => item.status === "invalid").length }, items } satisfies ImportPreview };
  }
  const match = /^\/api\/imports\/([^/]+)(\/apply)?$/u.exec(url.pathname);
  if (!match) return null;
  const id = decodeURIComponent(match[1]);
  const batch = await db.prepare("SELECT epoch, expires_at FROM cloud_import_batches WHERE id = ?").bind(id).first<{ epoch: string; expires_at: number }>();
  if (!batch || batch.expires_at < now) throw new CloudHttpError(404, "IMPORT_NOT_FOUND", "导入预检已过期，请重新检查文件。");
  if (batch.epoch !== epoch) throw new CloudHttpError(409, "STALE_DATA_EPOCH", "资料库已变化，请重新检查文件。");
  if (request.method === "DELETE" && !match[2]) { await db.prepare("DELETE FROM cloud_import_batches WHERE id = ?").bind(id).run(); return { body: null }; }
  if (request.method !== "POST" || !match[2]) return null;
  const body = await jsonObject(request, 4096);
  if (!["skip", "copy", "update"].includes(String(body.strategy))) throw new CloudHttpError(400, "INVALID_IMPORT", "无效的重复项处理策略。");
  const strategy = body.strategy as ImportStrategy;
  await db.prepare("UPDATE cloud_import_batches SET strategy=? WHERE id=? AND strategy IS NULL").bind(strategy, id).run();
  const policy = await db.prepare("SELECT strategy FROM cloud_import_batches WHERE id=?").bind(id).first<{ strategy: string }>();
  if (policy?.strategy !== strategy) throw new CloudHttpError(409, "IMPORT_STRATEGY_LOCKED", "此预检已使用其他策略，请重新检查文件。");
  const rows = (await db.prepare("SELECT * FROM cloud_import_items WHERE batch_id = ? ORDER BY item_index").bind(id).all<Item>()).results;
  const items: ImportApplyItem[] = [];
  for (const row of rows) {
    if (row.result_json) { items.push(JSON.parse(row.result_json)); continue; }
    const result = (status: ImportApplyItem["status"], documentId: string | null, error: string | null = null): ImportApplyItem => ({ id: row.id, index: row.item_index, status, documentId, error });
    if (row.error || (row.existing_id && strategy === "skip")) {
      const value = result(row.error ? "failed" : "skipped", row.error ? null : row.existing_id, row.error);
      await db.prepare("UPDATE cloud_import_items SET result_json = ? WHERE id = ? AND result_json IS NULL").bind(JSON.stringify(value), row.id).run();
    } else {
      const payload = JSON.parse(row.payload_json) as Payload;
      const timestamp = new Date().toISOString();
      const updating = Boolean(row.existing_id && strategy === "update");
      const documentId = updating ? row.existing_id! : row.id;
      const revision = updating ? row.existing_revision! + 1 : 1;
      const mutation = updating
        ? db.prepare(`UPDATE cloud_documents SET title=?, markdown=?, final_url=?, canonical_url=?, author=?, published_at=?, source_note=?, favorite=?, revision=revision+1, updated_at=? WHERE id=? AND revision=? AND kind='article' AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM cloud_import_items WHERE id=? AND result_json IS NULL)`).bind(payload.title, payload.markdown, payload.finalUrl, payload.canonicalUrl, payload.author, payload.publishedAt, payload.sourceNote, Number(payload.favorite), timestamp, documentId, row.existing_revision, row.id)
        : db.prepare(`INSERT INTO cloud_documents(id, source_url, title, markdown, status, source_note, revision, created_at, updated_at, final_url, canonical_url, author, published_at, favorite) SELECT ?, ?, ?, ?, 'ready', ?, 1, ?, ?, ?, ?, ?, ?, ? FROM cloud_import_items WHERE id=? AND result_json IS NULL`).bind(documentId, row.source_url, payload.title, payload.markdown, payload.sourceNote, timestamp, timestamp, payload.finalUrl, payload.canonicalUrl, payload.author, payload.publishedAt, Number(payload.favorite), row.id);
      const success = JSON.stringify(result(updating ? "updated" : "created", documentId));
      const conflict = JSON.stringify(result("conflict", row.existing_id, "预检后文章已变化，请重新检查。"));
      await db.batch!([mutation, db.prepare(`DELETE FROM cloud_semantic_indexes WHERE document_id=? AND EXISTS (SELECT 1 FROM cloud_documents WHERE id=? AND revision=? AND updated_at=?)`).bind(documentId, documentId, revision, timestamp), db.prepare(`UPDATE cloud_import_items SET result_json=CASE WHEN EXISTS (SELECT 1 FROM cloud_documents WHERE id=? AND revision=? AND updated_at=?) THEN ? ELSE ? END WHERE id=? AND result_json IS NULL`).bind(documentId, revision, timestamp, success, conflict, row.id)]);
    }
    const saved = await db.prepare("SELECT result_json FROM cloud_import_items WHERE id=?").bind(row.id).first<{ result_json: string }>();
    items.push(JSON.parse(saved!.result_json));
  }
  return { body: { id, status: "applied", strategy, counts: { created: items.filter((item) => item.status === "created").length, updated: items.filter((item) => item.status === "updated").length, skipped: items.filter((item) => item.status === "skipped").length, conflicts: items.filter((item) => item.status === "conflict").length, failed: items.filter((item) => item.status === "failed").length }, items } satisfies ImportApplyResult };
}
