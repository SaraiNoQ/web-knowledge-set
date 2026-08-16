import {
  CloudHttpError,
  createClip,
  exchangePairing,
  extensionCors,
  extensionOrigin,
  jsonObject,
  type D1Database,
} from "./extension";

interface ClipEnv { DB: D1Database }

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
      if (method !== "POST" || headers.some((value) => value !== "authorization" && value !== "content-type")) {
        throw new CloudHttpError(403, "EXTENSION_PREFLIGHT_REJECTED", "Extension preflight rejected");
      }
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== "POST") throw new CloudHttpError(405, "METHOD_NOT_ALLOWED", "POST required");
    if (url.pathname === "/api/browser-extension/pair") {
      return json(await exchangePairing(env.DB, await jsonObject(request, 4_096), extension.browser), 201, cors);
    }
    if (url.pathname === "/api/browser-extension/clips") {
      return json(await createClip(env.DB, request), 201, cors);
    }
    throw new CloudHttpError(404, "NOT_FOUND", "Endpoint not found");
  } catch (error) {
    const failure = error instanceof CloudHttpError ? error : new CloudHttpError(500, "INTERNAL_ERROR", "Request failed");
    return json({ error: { code: failure.code, message: failure.message } }, failure.status, cors);
  }
}

export default { fetch: handleClipRequest };
