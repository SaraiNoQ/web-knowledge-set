import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { fetchWithBrowser } from "../server/browser.js";
import { captureUrl } from "../server/capture.js";
import { CapturePipelineError, validateUrl, type PublicTarget } from "../server/url-security.js";

async function chromiumDescendants(parent: number): Promise<number[]> {
  const children = await readFile(`/proc/${parent}/task/${parent}/children`, "utf8")
    .then((value) => value.trim().split(/\s+/u).filter(Boolean).map(Number))
    .catch(() => []);
  const descendants = (await Promise.all(children.map(chromiumDescendants))).flat();
  const browsers = await Promise.all(children.map(async (pid) => ({
    pid,
    command: await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => ""),
  })));
  return [
    ...browsers.filter(({ command }) => /(?:chrome|chromium|headless_shell)/iu.test(command)).map(({ pid }) => pid),
    ...descendants,
  ];
}

async function assertProcessesExit(processes: Set<number>) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const survivors = (await Promise.all([...processes].map(async (pid) =>
      readFile(`/proc/${pid}/cmdline`).then(() => pid).catch(() => null)
    ))).filter((pid) => pid !== null);
    if (!survivors.length) return;
    if (attempt === 99) assert.fail(`Chromium processes survived capture: ${survivors.join(", ")}`);
    await delay(10);
  }
}

test("dynamic pages use sandboxed Chromium and close its processes", {
  skip: process.platform !== "linux" || process.getuid?.() === 0
    ? "requires non-root Linux Chromium sandbox"
    : false,
  timeout: 30_000,
}, async () => {
  const fixture = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    if (request.url === "/slow") {
      response.write("<!doctype html><title>永不完成的页面</title>");
      return;
    }
    response.end(`<!doctype html>
      <title>动态页面</title>
      <article><p>正在加载正文。</p></article>
      <script>
        document.querySelector("article").innerHTML =
          "<h1>动态渲染成功</h1><p>" + "这是由浏览器执行脚本后生成的可验证正文。".repeat(30) + "</p>";
      </script>`);
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const address = fixture.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://public.test:${address.port}/dynamic`;
  const resolveTarget = async (input: string | URL): Promise<PublicTarget> => ({
    url: validateUrl(input),
    address: "127.0.0.1",
    family: 4,
  });
  const launched = new Set<number>();
  let settled = false;

  try {
    const pending = captureUrl(url, { resolveTarget }).finally(() => { settled = true; });
    while (!settled) {
      for (const pid of await chromiumDescendants(process.pid)) launched.add(pid);
      await delay(10);
    }
    const result = await pending;
    assert.equal(result.mode, "browser");
    assert.equal(result.warning, null);
    assert.match(result.markdown, /动态渲染成功/u);
    assert.ok(launched.size > 0, "the test must observe the real Chromium process");
    assert.deepEqual(await chromiumDescendants(process.pid), []);
    await assertProcessesExit(launched);

    let resolutions = 0;
    const fallback = await captureUrl(url, {
      resolveTarget: async (input) => {
        resolutions += 1;
        if (resolutions === 1) return resolveTarget(input);
        throw new CapturePipelineError("BROWSER_FAILED", "forced browser failure");
      },
    });
    assert.equal(fallback.mode, "http");
    assert.equal(fallback.warning, "正文可能不完整；浏览器回退失败");

    const timedLaunched = new Set<number>();
    const proxyPorts = new Set<number>();
    let timedSettled = false;
    const timedResult = fetchWithBrowser(url.replace("/dynamic", "/slow"), {
      resolveTarget,
      timeoutMs: 1_000,
    }).then(
      () => null,
      (cause: unknown) => cause,
    ).finally(() => { timedSettled = true; });
    while (!timedSettled) {
      for (const pid of await chromiumDescendants(process.pid)) {
        timedLaunched.add(pid);
        const command = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
        const match = command.match(/--proxy-server=http:\/\/127\.0\.0\.1:(\d+)/u);
        if (match) proxyPorts.add(Number(match[1]));
      }
      await delay(10);
    }
    const timedError = await timedResult;
    assert.ok(timedError instanceof CapturePipelineError);
    assert.equal(timedError.code, "BROWSER_FAILED");
    assert.equal(timedError.message, "浏览器抓取超时");
    assert.ok(timedLaunched.size > 0, "the timeout test must observe Chromium");
    assert.ok(proxyPorts.size > 0, "the timeout test must observe Chromium's safe proxy");
    assert.deepEqual(await chromiumDescendants(process.pid), []);
    await assertProcessesExit(timedLaunched);
    for (const port of proxyPorts) {
      await assert.rejects(fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(500) }));
    }
  } finally {
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
  }
});
