import {
  CloudHttpError,
  createPairingCode,
  getDocument,
  jsonObject,
  listDocuments as listCloudDocuments,
  listPairings,
  revokePairing,
  type D1Database,
} from "./extension";

interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}

export interface CloudEnv {
  ASSETS: AssetFetcher;
  DB: D1Database;
}

const DATA_EPOCH_HEADER = "X-Zhiye-Data-Epoch";
const SECURITY_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "script-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; "),
  "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function json(body: unknown, status = 200, epoch?: string) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...SECURITY_HEADERS,
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      ...(epoch ? { [DATA_EPOCH_HEADER]: epoch } : {}),
    },
  });
}

async function setting<T>(env: CloudEnv, key: string): Promise<{ value: T; revision: number } | null> {
  const row = await env.DB.prepare("SELECT value, revision FROM app_settings WHERE key = ?")
    .bind(key)
    .first<{ value: string; revision: number }>();
  if (!row) return null;
  return { value: JSON.parse(row.value) as T, revision: row.revision };
}

async function dataEpoch(env: CloudEnv) {
  const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = 'data_epoch'")
    .first<{ value: string }>();
  return row?.value || null;
}

async function api(request: Request, env: CloudEnv, url: URL) {
  const epoch = await dataEpoch(env);
  if (!epoch) {
    return json({ error: { code: "CLOUD_NOT_INITIALIZED", message: "Cloud database migration is required" } }, 503);
  }
  if (url.pathname === "/api/settings/browser-extension/pairing-code" && request.method === "POST") {
    if (request.headers.get(DATA_EPOCH_HEADER) !== epoch) {
      return json({ error: { code: "STALE_DATA_EPOCH", message: "Cloud data changed; reload before writing" } }, 409, epoch);
    }
    const body = await jsonObject(request, 4_096);
    if (Object.keys(body).length) throw new CloudHttpError(400, "INVALID_PAIRING_REQUEST", "Pairing code request accepts no fields");
    return json(await createPairingCode(env.DB), 201, epoch);
  }
  if (url.pathname === "/api/settings/browser-extension/pairings" && request.method === "GET") {
    return json({ pairings: await listPairings(env.DB) }, 200, epoch);
  }
  const pairing = url.pathname.match(/^\/api\/settings\/browser-extension\/pairings\/([^/]+)$/u);
  if (pairing && request.method === "DELETE") {
    if (request.headers.get(DATA_EPOCH_HEADER) !== epoch) {
      return json({ error: { code: "STALE_DATA_EPOCH", message: "Cloud data changed; reload before writing" } }, 409, epoch);
    }
    const body = await jsonObject(request, 4_096);
    if (Object.keys(body).length) throw new CloudHttpError(400, "INVALID_PAIRING_DELETE", "Pairing deletion accepts no fields");
    let id: string;
    try { id = decodeURIComponent(pairing[1]); }
    catch { throw new CloudHttpError(400, "INVALID_PATH", "Invalid pairing identifier"); }
    if (!await revokePairing(env.DB, id)) throw new CloudHttpError(404, "PAIRING_NOT_FOUND", "Pairing not found");
    return new Response(null, { status: 204, headers: { ...SECURITY_HEADERS, "Cache-Control": "no-store", [DATA_EPOCH_HEADER]: epoch } });
  }
  if (request.method !== "GET") {
    return json({ error: { code: "CLOUD_FEATURE_PENDING", message: "This cloud mutation is not migrated yet" } }, 501, epoch);
  }

  const documentPath = url.pathname.match(/^\/api\/documents\/([^/]+)(?:\/(draft|assets|duplicate|captures))?$/u);
  if (documentPath) {
    let id: string;
    try { id = decodeURIComponent(documentPath[1]); }
    catch { throw new CloudHttpError(400, "INVALID_PATH", "Invalid document identifier"); }
    if (documentPath[2] === "draft" || documentPath[2] === "duplicate") return json(null, 200, epoch);
    if (documentPath[2] === "assets" || documentPath[2] === "captures") return json([], 200, epoch);
    const document = await getDocument(env.DB, id);
    if (!document) throw new CloudHttpError(404, "DOCUMENT_NOT_FOUND", "Document not found");
    return json(document, 200, epoch);
  }

  switch (url.pathname) {
    case "/api/settings/onboarding": {
      const row = await setting<{ completed: boolean }>(env, "onboarding");
      return json({ completed: row?.value.completed ?? true, revision: row?.revision ?? 0 }, 200, epoch);
    }
    case "/api/settings/recent-filters": {
      const row = await setting<unknown[]>(env, "recent_filters");
      return json({ filters: row?.value ?? [], revision: row?.revision ?? 0 }, 200, epoch);
    }
    case "/api/data-safety":
      return json({ mode: "ready", maintenance: false, recoveryError: null, health: null, backups: [], settings: null }, 200, epoch);
    case "/api/capture-queue":
      return json({ paused: false, active: 0, queued: 0 }, 200, epoch);
    case "/api/collections":
    case "/api/tags":
      return json([], 200, epoch);
    case "/api/documents": {
      return json(await listCloudDocuments(env.DB, url), 200, epoch);
    }
    default:
      return json({ error: { code: "CLOUD_FEATURE_PENDING", message: "This cloud API is not migrated yet" } }, 501, epoch);
  }
}

export async function handleRequest(request: Request, env: CloudEnv) {
  try {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, mode: "cloud-core" });
    if (url.pathname.startsWith("/api/")) return api(request, env, url);

    const asset = await env.ASSETS.fetch(request);
    const headers = new Headers(asset.headers);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
    return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
  } catch (error) {
    const failure = error instanceof CloudHttpError ? error : new CloudHttpError(500, "INTERNAL_ERROR", "Request failed");
    return json({ error: { code: failure.code, message: failure.message } }, failure.status);
  }
}

export default { fetch: handleRequest };
