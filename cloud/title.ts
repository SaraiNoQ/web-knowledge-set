import {
  normalizeGeneratedTitle,
  TITLE_REPAIR_SYSTEM_PROMPT,
  TITLE_SYSTEM_PROMPT,
  titleRepairPrompt,
  titleSource,
} from "../shared/title";
import { complete, llmRequestKey, settingsRow, type CloudReply } from "./ai";
import { CloudHttpError, getDocument, jsonObject, type D1Database } from "./extension";

const TITLE_MAX_TOKENS = 1_024;
const TITLE_TIMEOUT_MS = 30_000;

function changes(result: { meta: { changes?: number } }) { return result.meta.changes ?? 0; }

export interface TitleSettings {
  endpointUrl: string;
  model: string;
}

function ask(settings: TitleSettings, apiKey: string, system: string, user: string) {
  return complete(settings.endpointUrl, settings.model, apiKey, system, user, TITLE_MAX_TOKENS, true, TITLE_TIMEOUT_MS);
}

/**
 * Returns a usable Chinese title, or null when the model answered with
 * something that is not a short single-line Chinese title. A first reply that
 * misses the cap or the language is retried once before giving up, so callers
 * keep the captured title only when the model failed twice.
 */
export async function generateDocumentTitle(settings: TitleSettings, apiKey: string, markdown: string) {
  const first = await ask(settings, apiKey, TITLE_SYSTEM_PROMPT, titleSource(markdown));
  if (first.finishReason !== "length") {
    const title = normalizeGeneratedTitle(first.output);
    if (title) return title;
  }
  const repaired = await ask(settings, apiKey, TITLE_REPAIR_SYSTEM_PROMPT, titleRepairPrompt(first.output, markdown));
  if (repaired.finishReason === "length") return null;
  return normalizeGeneratedTitle(repaired.output);
}

export async function handleTitleApi(request: Request, db: D1Database, url: URL): Promise<CloudReply | null> {
  const path = /^\/api\/documents\/([^/]+)\/auto-title$/u.exec(url.pathname);
  if (!path || request.method !== "POST") return null;
  const settings = await settingsRow(db);
  if (!settings.value.enabled) throw new CloudHttpError(409, "LLM_DISABLED", "Cloud AI is disabled");
  const document = await getDocument(db, decodeURIComponent(path[1]));
  if (!document) throw new CloudHttpError(404, "DOCUMENT_NOT_FOUND", "Document not found");
  const body = await jsonObject(request, 4_096);
  if (Object.keys(body).length !== 1 || typeof body.revision !== "number" ||
    !Number.isSafeInteger(body.revision) || body.revision < 1) {
    throw new CloudHttpError(400, "INVALID_DOCUMENT_UPDATE", "A positive revision is required");
  }
  if (document.deletedAt) throw new CloudHttpError(409, "DOCUMENT_DELETED", "Restore the document before generating a title", document);
  if (document.revision !== body.revision) throw new CloudHttpError(409, "DOCUMENT_CONFLICT", "Document was updated elsewhere", document);
  const title = await generateDocumentTitle(
    { endpointUrl: settings.value.remote.endpointUrl, model: settings.value.remote.model },
    llmRequestKey(request),
    document.markdown,
  );
  if (!title) throw new CloudHttpError(502, "TITLE_UNUSABLE", "The model did not return a usable title");
  if (title === document.title) return { body: document };
  if (!db.batch) throw new CloudHttpError(503, "CLOUD_BATCH_UNAVAILABLE", "D1 batch support is required");
  const now = new Date().toISOString();
  const [updated] = await db.batch([
    db.prepare(`UPDATE cloud_documents SET title = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND revision = ? AND deleted_at IS NULL`).bind(title, now, document.id, document.revision),
    db.prepare("DELETE FROM cloud_semantic_indexes WHERE document_id = ? AND EXISTS (" +
      "SELECT 1 FROM cloud_documents WHERE id = ? AND revision = ? AND updated_at = ? AND deleted_at IS NULL)")
      .bind(document.id, document.id, document.revision + 1, now),
  ]);
  if (changes(updated) !== 1) {
    const current = await getDocument(db, document.id);
    if (!current) throw new CloudHttpError(404, "DOCUMENT_NOT_FOUND", "Document not found");
    if (current.revision !== document.revision) throw new CloudHttpError(409, "DOCUMENT_CONFLICT", "Document was updated elsewhere", current);
    throw new CloudHttpError(409, "DOCUMENT_DELETED", "Restore the document before generating a title", current);
  }
  return { body: await getDocument(db, document.id) };
}
