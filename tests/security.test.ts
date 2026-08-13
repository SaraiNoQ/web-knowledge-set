import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import net from "node:net";
import test from "node:test";

import { hasLocalHost } from "../server/app.js";
import { createSafeProxy } from "../server/safe-proxy.js";

test("accepts one exact localhost Host header with an optional valid port", () => {
  for (const value of ["localhost", "LOCALHOST:4173", "127.0.0.1", "127.0.0.1:65535"]) {
    assert.equal(hasLocalHost(["Host", value]), true, value);
  }
  for (const value of [
    "", "localhost:0", "localhost:65536", "localhost.evil", "user@127.0.0.1:4173",
    "127.0.0.1#evil", "[::1]:4173",
  ]) assert.equal(hasLocalHost(["Host", value]), false, value);
  assert.equal(hasLocalHost([]), false);
  assert.equal(hasLocalHost(["Host", "127.0.0.1:4173", "host", "localhost:4173"]), false);
});

test("safe browser proxy counts HTTP upload bytes in its shared budget", async () => {
  const upstream = createServer((incoming, response) => {
    incoming.resume();
    incoming.once("end", () => {
      response.writeHead(204);
      response.end();
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== "string");
  const proxy = await createSafeProxy(async (input) => ({
    url: new URL(input),
    address: "127.0.0.1",
    family: 4,
  }), 32);
  const proxyUrl = new URL(proxy.url);
  const body = Buffer.alloc(33);
  try {
    const outcome = await new Promise<number | "error">((resolve) => {
      const outgoing = request({
        hostname: proxyUrl.hostname,
        port: proxyUrl.port,
        method: "POST",
        path: `http://public.test:${upstreamAddress.port}/upload`,
      });
      outgoing.once("error", () => resolve("error"));
      outgoing.once("response", (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
        response.once("error", () => resolve("error"));
      });
      outgoing.end(body);
    });
    assert.notEqual(outcome, 204);
    assert.equal(proxy.limitExceeded(), true);
  } finally {
    await proxy.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("safe browser proxy close terminates an active client connection", async () => {
  const proxy = await createSafeProxy();
  const proxyUrl = new URL(proxy.url);
  const client = net.connect(Number(proxyUrl.port), proxyUrl.hostname);
  await new Promise<void>((resolve, reject) => {
    client.once("connect", resolve);
    client.once("error", reject);
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    const clientClosed = new Promise<void>((resolve) => client.once("close", () => resolve()));
    await Promise.race([
      Promise.all([proxy.close(), clientClosed]),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("proxy close timed out")), 500);
      }),
    ]);
    assert.equal(client.destroyed, true);
  } finally {
    if (timer) clearTimeout(timer);
    client.destroy();
  }
});

test("safe browser proxy counts CONNECT head bytes before forwarding", async () => {
  let received = 0;
  const upstream = net.createServer((socket) => {
    socket.on("data", (chunk) => { received += chunk.length; });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== "string");
  const proxy = await createSafeProxy(async (input) => ({
    url: new URL(input),
    address: "127.0.0.1",
    family: 4,
  }), 8);
  const proxyUrl = new URL(proxy.url);
  const client = net.connect(Number(proxyUrl.port), proxyUrl.hostname);
  try {
    await new Promise<void>((resolve, reject) => {
      client.once("connect", resolve);
      client.once("error", reject);
    });
    const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));
    client.write(
      `CONNECT public.test:${upstreamAddress.port} HTTP/1.1\r\nHost: public.test:${upstreamAddress.port}\r\n\r\n123456789`,
    );
    await closed;
    assert.equal(proxy.limitExceeded(), true);
    assert.equal(received, 0);
  } finally {
    client.destroy();
    await proxy.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
