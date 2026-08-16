interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T>(): Promise<T | null>;
}

interface D1Database {
  prepare(sql: string): D1Statement;
}

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
  if (request.method !== "GET") {
    return json({ error: { code: "CLOUD_FEATURE_PENDING", message: "This cloud mutation is not migrated yet" } }, 501, epoch);
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
      const page = Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1);
      return json({ items: [], page, pageSize: 30, total: 0 }, 200, epoch);
    }
    default:
      return json({ error: { code: "CLOUD_FEATURE_PENDING", message: "This cloud API is not migrated yet" } }, 501, epoch);
  }
}

export async function handleRequest(request: Request, env: CloudEnv) {
  const url = new URL(request.url);
  if (url.pathname === "/health") return json({ ok: true, mode: "cloud-core" });
  if (url.pathname.startsWith("/api/")) return api(request, env, url);

  const asset = await env.ASSETS.fetch(request);
  const headers = new Headers(asset.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
}

export default { fetch: handleRequest };
