import { normalizeGeneratedTitle, TITLE_SYSTEM_PROMPT, titleSource } from "../shared/title";
import { complete, llmRequestKey, settingsRow, type CloudReply } from "./ai";
import { CloudHttpError, getDocument, jsonObject, type D1Database } from "./extension";

const TITLE_MAX_TOKENS = 1_024;
const TITLE_TIMEOUT_MS = 30_000;

function changes(result: { meta: { changes?: number } }) { return result.meta.changes ?? 0; }

export interface TitleSettings {
  endpointUrl: string;
  model: string;
}

/**
 * Returns a usable Chinese title, or null when the model answered with
 * something that is not a short single-line title. Callers keep the captured
 * title in that case rather than failing the capture.
 */
export async function generateDocumentTitle(settings: TitleSettings, apiKey: string, markdown: string) {
  const completed = await complete(
    settings.endpointUrl,
    settings.model,
    apiKey,
    TITLE_SYSTEM_PROMPT,
    titleSource(markdown),
    TITLE_MAX_TOKENS,
    true,
    TITLE_TIMEOUT_MS,
  );
  if (completed.finishReason === "length") return null;
  return normalizeGeneratedTitle(completed.output);
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
  const updated = await db.prepare(`UPDATE cloud_documents SET title = ?, revision = revision + 1, updated_at = ?
    WHERE id = ? AND revision = ? AND deleted_at IS NULL`)
    .bind(title, new Date().toISOString(), document.id, document.revision).run();
  if (changes(updated) !== 1) {
    const current = await getDocument(db, document.id);
    if (!current) throw new CloudHttpError(404, "DOCUMENT_NOT_FOUND", "Document not found");
    if (current.revision !== document.revision) throw new CloudHttpError(409, "DOCUMENT_CONFLICT", "Document was updated elsewhere", current);
    throw new CloudHttpError(409, "DOCUMENT_DELETED", "Restore the document before generating a title", current);
  }
  return { body: await getDocument(db, document.id) };
}
