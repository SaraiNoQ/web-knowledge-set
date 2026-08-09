import http, { type IncomingHttpHeaders } from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";

import { CapturePipelineError, resolvePublicTarget } from "./url-security.js";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const MAX_PROXY_BYTES = 25 * 1024 * 1024;

function cleanHeaders(headers: IncomingHttpHeaders, host?: string) {
  const cleaned: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(name.toLowerCase()) && value !== undefined) cleaned[name] = value;
  }
  if (host) cleaned.host = host;
  return cleaned;
}

function fail(socket: Duplex, status: number, message: string) {
  if (!socket.destroyed) {
    socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
}

export interface SafeProxy {
  url: string;
  limitExceeded(): boolean;
  close(): Promise<void>;
}

export async function createSafeProxy(): Promise<SafeProxy> {
  let transferred = 0;
  let exceeded = false;
  const consume = (size: number) => {
    transferred += size;
    if (transferred > MAX_PROXY_BYTES) exceeded = true;
    return !exceeded;
  };
  const server = http.createServer(async (request, response) => {
    try {
      if (!request.url) throw new CapturePipelineError("INVALID_URL", "代理请求缺少 URL");
      const target = await resolvePublicTarget(request.url);
      if (target.url.protocol !== "http:") {
        throw new CapturePipelineError("INVALID_URL", "HTTPS 请求必须使用 CONNECT 隧道");
      }

      const upstream = http.request({
        host: target.address,
        family: target.family,
        port: Number(target.url.port || 80),
        method: request.method,
        path: `${target.url.pathname}${target.url.search}`,
        headers: cleanHeaders(request.headers, target.url.host),
      });
      upstream.setTimeout(15_000, () => upstream.destroy(new Error("proxy upstream timeout")));
      upstream.on("response", (upstreamResponse) => {
        const declared = Number(upstreamResponse.headers["content-length"] ?? 0);
        if (Number.isFinite(declared) && declared > MAX_PROXY_BYTES - transferred) {
          exceeded = true;
          upstreamResponse.destroy();
          response.destroy(new Error("proxy byte limit exceeded"));
          return;
        }
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          cleanHeaders(upstreamResponse.headers),
        );
        upstreamResponse.on("data", (chunk: Buffer) => {
          if (!consume(chunk.length)) {
            upstreamResponse.destroy();
            response.destroy(new Error("proxy byte limit exceeded"));
          }
        });
        upstreamResponse.pipe(response);
      });
      upstream.on("error", () => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      request.pipe(upstream);
    } catch {
      response.writeHead(403, { "Content-Length": "0", Connection: "close" });
      response.end();
    }
  });

  server.on("connect", async (request, client, head) => {
    try {
      const authority = request.url ?? "";
      const target = await resolvePublicTarget(`https://${authority}`);
      const port = Number(target.url.port || 443);
      const upstream = net.connect({ host: target.address, family: target.family, port });
      upstream.setTimeout(15_000, () => upstream.destroy());
      upstream.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on("data", (chunk: Buffer) => {
        if (!consume(chunk.length)) {
          upstream.destroy();
          client.destroy();
        }
      });
      client.on("data", (chunk: Buffer) => {
        if (!consume(chunk.length)) {
          upstream.destroy();
          client.destroy();
        }
      });
      upstream.once("error", () => fail(client, 502, "Bad Gateway"));
      client.once("error", () => upstream.destroy());
    } catch {
      fail(client, 403, "Forbidden");
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Safe proxy did not bind a TCP port");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    limitExceeded: () => exceeded,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
