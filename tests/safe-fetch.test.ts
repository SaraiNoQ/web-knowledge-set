import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { safeFetchBinary } from "../server/safe-fetch.js";
import { CapturePipelineError, resolvePublicTarget, type PublicTarget } from "../server/url-security.js";

test("binary fetch revalidates redirects and enforces streamed byte limits", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { Location: `http://127.0.0.1:${(server.address() as { port: number }).port}/private` });
      response.end();
      return;
    }
    response.writeHead(200, { "Content-Type": "image/png" });
    response.end(Buffer.alloc(32));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const publicUrl = `http://public.test:${address.port}`;
  const localTarget = (path: string): PublicTarget => ({
    url: new URL(`${publicUrl}${path}`),
    address: "127.0.0.1",
    family: 4,
  });
  try {
    let resolutions = 0;
    await assert.rejects(
      safeFetchBinary(`${publicUrl}/redirect`, {
        maxBytes: 64,
        resolveTarget: async (input) => {
          resolutions += 1;
          return resolutions === 1 ? localTarget("/redirect") : resolvePublicTarget(input);
        },
      }),
      (error: unknown) => error instanceof CapturePipelineError && error.code === "BLOCKED_ADDRESS",
    );
    assert.equal(resolutions, 2);

    await assert.rejects(
      safeFetchBinary(`${publicUrl}/large`, {
        maxBytes: 8,
        resolveTarget: async () => localTarget("/large"),
      }),
      (error: unknown) => error instanceof CapturePipelineError && error.code === "RESPONSE_TOO_LARGE",
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
