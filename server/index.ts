import { homedir } from "node:os";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { createApp } from "./app.js";
import { acquireDataLock } from "./lock.js";

const dataDir = resolve(
  process.env.KB_DATA_DIR ??
    (process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support", "dev.local.zhiye")
      : join(homedir(), ".local", "share", "dev.local.zhiye")),
);
const staticDir = resolve(process.env.KB_STATIC_DIR ?? join(process.cwd(), "dist"));
const requestedPort = Number(process.env.KB_PORT ?? 0);
if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
  throw new Error("KB_PORT must be an integer from 0 to 65535");
}

const releaseLock = acquireDataLock(dataDir);
const dev = process.env.KB_DEV === "1";
const desktop = process.env.KB_DESKTOP === "1";
const app = createApp({
  dataDir,
  staticDir,
  dev,
  onDesktopCloseReady: desktop ? (attemptId) => console.log(`ZHIYE_CLOSE_READY ${attemptId}`) : undefined,
});
const vite = dev
  ? await (await import("vite")).createServer({ server: { middlewareMode: true }, appType: "spa" })
  : null;
const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (vite && pathname !== "/health" && pathname !== "/launch" && !pathname.startsWith("/api/")) {
    vite.middlewares(request, response, () => void app.handler(request, response));
  } else {
    void app.handler(request, response);
  }
});

let closing = false;
const desktopInput = desktop ? createInterface({ input: process.stdin }) : null;
async function close(exitCode = 0) {
  if (closing) return;
  closing = true;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  await vite?.close();
  await app.close();
  desktopInput?.close();
  releaseLock();
  process.exitCode = exitCode;
}

desktopInput?.on("line", (line) => {
  if (line === "ZHIYE_SHUTDOWN") void close();
});
desktopInput?.once("close", () => void close());

process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
server.once("error", (error) => {
  console.error(error);
  void close(1);
});

server.listen(requestedPort, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind a TCP port");
  const launchUrl = `http://127.0.0.1:${address.port}/launch?token=${encodeURIComponent(app.bootstrapToken)}`;
  console.log(`ZHIYE_READY ${launchUrl}`);
});
