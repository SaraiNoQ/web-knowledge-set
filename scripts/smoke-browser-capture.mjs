import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

if (process.platform !== "linux" || process.getuid?.() === 0) {
  throw new Error("browser capture smoke requires non-root Linux");
}

const runtime = resolve(process.argv[2] ?? ".");
const { captureUrl } = await import(pathToFileURL(join(runtime, "dist-server/server/capture.js")).href);
const { fetchWithBrowser } = await import(pathToFileURL(join(runtime, "dist-server/server/browser.js")).href);

async function chromiumDescendants(parent) {
  const children = await readFile(`/proc/${parent}/task/${parent}/children`, "utf8")
    .then((value) => value.trim().split(/\s+/u).filter(Boolean).map(Number))
    .catch(() => []);
  const nested = (await Promise.all(children.map(chromiumDescendants))).flat();
  const commands = await Promise.all(children.map(async (pid) => ({
    pid,
    command: await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => ""),
  })));
  return [...commands.filter(({ command }) => /(?:chrome|chromium|headless_shell)/iu.test(command)), ...nested];
}

const fixture = createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  if (_request.url === "/slow") {
    response.write("<!doctype html><title>slow</title>");
    return;
  }
  response.end(`<!doctype html><title>dynamic</title><article><p>loading</p></article><script>
    document.querySelector("article").innerHTML = "<h1>dynamic-ready</h1><p>" + "browser rendered content ".repeat(40) + "</p>";
  </script>`);
});
await new Promise((done) => fixture.listen(0, "127.0.0.1", done));
const address = fixture.address();
assert.ok(address && typeof address !== "string");
const url = `http://public.test:${address.port}/dynamic`;
const resolveTarget = async (input) => ({ url: new URL(input), address: "127.0.0.1", family: 4 });
const launched = new Map();
let settled = false;

async function assertProcessesExit(processes) {
  const pids = [...processes];
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const survivors = (await Promise.all(pids.map(async (pid) =>
      readFile(`/proc/${pid}/cmdline`).then(() => pid).catch(() => null)
    ))).filter((pid) => pid !== null);
    if (!survivors.length) return;
    if (attempt === 99) assert.fail(`Chromium survived capture: ${survivors.join(", ")}`);
    await new Promise((done) => setTimeout(done, 10));
  }
}

try {
  const pending = captureUrl(url, { resolveTarget }).finally(() => { settled = true; });
  while (!settled) {
    for (const child of await chromiumDescendants(process.pid)) launched.set(child.pid, child.command);
    await new Promise((done) => setTimeout(done, 10));
  }
  const result = await pending;
  assert.equal(result.mode, "browser");
  assert.match(result.markdown, /dynamic-ready/u);
  assert.ok(launched.size > 0, "real Chromium was not observed");
  assert.ok([...launched.values()].every((command) => !command.includes("--no-sandbox")), "Chromium sandbox was disabled");

  await assertProcessesExit(launched.keys());

  const timedLaunched = new Map();
  let timedSettled = false;
  const timed = fetchWithBrowser(url.replace("/dynamic", "/slow"), { resolveTarget, timeoutMs: 1_000 })
    .then(() => null, (cause) => cause)
    .finally(() => { timedSettled = true; });
  while (!timedSettled) {
    for (const child of await chromiumDescendants(process.pid)) timedLaunched.set(child.pid, child.command);
    await new Promise((done) => setTimeout(done, 10));
  }
  const timedError = await timed;
  assert.equal(timedError?.code, "BROWSER_FAILED");
  assert.ok(timedLaunched.size > 0, "timeout did not launch real Chromium");
  assert.ok([...timedLaunched.values()].every((command) => !command.includes("--no-sandbox")), "Chromium sandbox was disabled");
  await assertProcessesExit(timedLaunched.keys());
  console.log("ZHIYE_BROWSER_SMOKE_OK");
} finally {
  await new Promise((done) => fixture.close(done));
}
