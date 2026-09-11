import {
  CloudHttpError,
  clipInput,
  createClip,
  epochGuardedDatabase,
  exchangePairing,
  extensionCors,
  extensionOrigin,
  jsonObject,
  MAX_CLOUD_ROW_TEXT_BYTES,
  recoverExpiredRestore,
  type D1Database,
  verifiedExtensionToken,
} from "./extension";
import { fetchDocumentAssets } from "./assets";
import type { R2Bucket } from "./backup";
import { llmRequestKeyState, settingsRow } from "./ai";
import { generateDocumentTitle } from "./title";

interface ClipEnv { DB: D1Database; IMAGES: R2Bucket }

interface ClipTitle { title: string | null; error: string | null }

/**
 * The extension only sends a key when the user asked for an AI title. A failure
 * is reported back to the popup as a stable code, but never fails the clip.
 */
async function clipTitle(db: D1Database, key: string, markdown: string): Promise<ClipTitle> {
  try {
    const settings = await settingsRow(db);
    if (!settings.value.enabled) return { title: null, error: "LLM_DISABLED" };
    const title = await generateDocumentTitle(
      { endpointUrl: settings.value.remote.endpointUrl, model: settings.value.remote.model },
      key,
      markdown,
    );
    if (!title) return { title: null, error: "TITLE_UNUSABLE" };
    return { title, error: null };
  } catch (error) {
    const code = error instanceof CloudHttpError ? error.code : "TITLE_FAILED";
    console.error("[clip] auto title failed", JSON.stringify({
      code,
      error: error instanceof Error ? error.message : String(error),
    }));
    return { title: null, error: code };
  }
}

function json(body: unknown, status: number, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

export async function handleClipRequest(request: Request, env: ClipEnv) {
  let cors: Record<string, string> = {};
  try {
    const url = new URL(request.url);
    const extension = extensionOrigin(request);
    cors = extensionCors(extension.origin);
    if (request.method === "OPTIONS") {
      const method = request.headers.get("Access-Control-Request-Method");
      const headers = (request.headers.get("Access-Control-Request-Headers") || "")
        .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
      if (method !== "POST" || headers.some((value) => !["authorization", "content-type", "x-zhiye-llm-key"].includes(value))) {
        throw new CloudHttpError(403, "EXTENSION_PREFLIGHT_REJECTED", "Extension preflight rejected");
      }
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== "POST") throw new CloudHttpError(405, "METHOD_NOT_ALLOWED", "POST required");
    const storedEpoch = await env.DB.prepare("SELECT value FROM app_settings WHERE key = 'data_epoch'").first<{ value: string }>();
    if (!storedEpoch) throw new CloudHttpError(503, "CLOUD_NOT_INITIALIZED", "Cloud database migration is required");
    const epoch = await recoverExpiredRestore(env.DB, storedEpoch.value);
    if (!epoch || epoch.startsWith("restore:")) throw new CloudHttpError(503, "CLOUD_MAINTENANCE", "Cloud restore is in progress");
    const db = epochGuardedDatabase(env.DB, epoch);
    if (url.pathname === "/api/browser-extension/pair") {
      return json(await exchangePairing(db, await jsonObject(request, 4_096), extension.browser), 201, cors);
    }
    if (url.pathname === "/api/browser-extension/clips") {
      // Authenticate before the AI title request: an unpaired caller must not
      // be able to spend a provider request through this Worker.
      const tokenHash = await verifiedExtensionToken(db, request);
      const input = clipInput(await jsonObject(request));
      const rewritten = await fetchDocumentAssets({ IMAGES: env.IMAGES }, input.markdown, input.sourceUrl);
      if (new TextEncoder().encode(rewritten.markdown).byteLength > MAX_CLOUD_ROW_TEXT_BYTES) {
        throw new CloudHttpError(413, "MARKDOWN_TOO_LARGE", "markdown exceeds the D1 row budget");
      }
      const { key, invalid } = llmRequestKeyState(request);
      const generated = key ? await clipTitle(db, key, rewritten.markdown) : null;
      const clipped = { ...input, markdown: rewritten.markdown, ...(generated?.title ? { title: generated.title } : {}) };
      const saved = await createClip(db, tokenHash, clipped);
      return json({ ...saved, aiTitleError: generated?.error ?? (invalid ? "LLM_KEY_INVALID" : null) }, 201, cors);
    }
    throw new CloudHttpError(404, "NOT_FOUND", "Endpoint not found");
  } catch (error) {
    const failure = error instanceof CloudHttpError ? error : new CloudHttpError(500, "INTERNAL_ERROR", "Request failed");
    return json({ error: { code: failure.code, message: failure.message } }, failure.status, cors);
  }
}

export default { fetch: handleClipRequest };

