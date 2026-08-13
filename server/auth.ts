import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const SESSION_COOKIE = "zhiye_session";

function token() {
  return randomBytes(32).toString("base64url");
}

function equal(left: string | undefined, right: string) {
  if (!left) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookies(header: string | undefined) {
  const result = new Map<string, string>();
  for (const item of header?.split(";") ?? []) {
    const separator = item.indexOf("=");
    if (separator < 1) continue;
    const name = item.slice(0, separator).trim();
    try {
      result.set(name, decodeURIComponent(item.slice(separator + 1).trim()));
    } catch {
      // Ignore malformed cookies; authentication will fail normally.
    }
  }
  return result;
}

export interface AuthOptions {
  bootstrapToken?: string;
  sessionToken?: string;
  dev?: boolean;
  trustedLocalhost?: boolean;
}

export function createAuth(options: AuthOptions = {}) {
  const bootstrapToken = options.bootstrapToken || token();
  const sessionToken = options.sessionToken || token();
  const dev = options.dev ?? process.env.KB_DEV === "1";
  const trustedLocalhost = options.trustedLocalhost ?? process.env.KB_TRUST_LOCALHOST === "1";
  if (dev && trustedLocalhost) throw new Error("KB_TRUST_LOCALHOST cannot be used with KB_DEV=1");
  let launchAvailable = true;

  const establishSession = (response: ServerResponse) => {
    response.writeHead(302, {
      Location: "/",
      "Set-Cookie": `${SESSION_COOKIE}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/`,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    });
    response.end();
  };

  return {
    bootstrapToken,

    isAuthenticated(request: IncomingMessage) {
      if (dev) return true;
      return equal(cookies(request.headers.cookie).get(SESSION_COOKIE), sessionToken);
    },

    launch(requestUrl: URL, response: ServerResponse) {
      if (trustedLocalhost) {
        establishSession(response);
        return;
      }
      if (!launchAvailable || !equal(requestUrl.searchParams.get("token") ?? undefined, bootstrapToken)) {
        response.writeHead(401, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        response.end(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Invalid launch token" } }));
        return;
      }
      launchAvailable = false;
      establishSession(response);
    },

    establishTrustedSession(request: IncomingMessage, response: ServerResponse) {
      if (!trustedLocalhost || equal(cookies(request.headers.cookie).get(SESSION_COOKIE), sessionToken)) return false;
      establishSession(response);
      return true;
    },
  };
}
