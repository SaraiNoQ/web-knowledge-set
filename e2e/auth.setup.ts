import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const authState = resolve("test-results/e2e-auth.json");

test("uses the one-shot production session boundary", async ({ request }) => {
  expect((await request.get("/api/documents")).status()).toBe(401);

  const launch = await request.get("/launch?token=e2e-bootstrap-token", { maxRedirects: 0 });
  expect(launch.status()).toBe(302);
  expect(launch.headers()["set-cookie"]).toMatch(/HttpOnly; SameSite=Strict; Path=\//u);
  expect((await request.get("/launch?token=e2e-bootstrap-token", { maxRedirects: 0 })).status()).toBe(401);

  const documents = await request.get("/api/documents");
  expect(documents.status()).toBe(200);
  const dataEpoch = documents.headers()["x-zhiye-data-epoch"];
  expect(dataEpoch).toBeTruthy();

  const rejectedOrigin = await request.post("/api/documents", {
    data: { url: "https://example.com/cross-origin" },
    headers: { Origin: "https://attacker.example", "X-Zhiye-Data-Epoch": dataEpoch },
  });
  expect(rejectedOrigin.status()).toBe(403);
  expect((await rejectedOrigin.json()).error.code).toBe("ORIGIN_REJECTED");

  const rejectedHost = await request.get("/health", { headers: { Host: "attacker.example" } });
  expect(rejectedHost.status()).toBe(400);
  expect((await rejectedHost.json()).error.code).toBe("INVALID_HOST");

  const shell = await request.get("/");
  expect(shell.status()).toBe(200);
  expect(shell.headers()["content-security-policy"]).toBe([
    "default-src 'self'",
    "connect-src 'self' ipc: http://ipc.localhost",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "script-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; "));
  expect(shell.headers()["x-frame-options"]).toBe("DENY");

  await mkdir(dirname(authState), { recursive: true });
  await request.storageState({ path: authState });
});
