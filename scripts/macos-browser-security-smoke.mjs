import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import dgram from "node:dgram";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

assert.ok(process.argv[2], "packaged runtime path is required");
const runtime = resolve(process.argv[2]);
process.env.PLAYWRIGHT_BROWSERS_PATH = join(runtime, "browsers");

const require = createRequire(join(runtime, "package.json"));
const { chromium } = require("playwright");
const executableRelative = relative(join(runtime, "browsers"), chromium.executablePath());
assert.ok(executableRelative && !executableRelative.startsWith("..") && !isAbsolute(executableRelative));
const { browserLaunchOptions } = await import(pathToFileURL(join(runtime, "dist-server/server/browser.js")));
const options = browserLaunchOptions("http://127.0.0.1:9");
assert.equal(options.chromiumSandbox, true);
assert.ok(options.args.includes("--force-webrtc-ip-handling-policy=disable_non_proxied_udp"));

async function probeWebRtc(launchOptions, verifyCommandLine = false) {
  const udp = dgram.createSocket("udp4");
  await new Promise((resolveBind) => udp.bind(0, "127.0.0.1", resolveBind));
  let browser;
  let timer;
  try {
    browser = await chromium.launch(launchOptions);
    const page = await browser.newPage();
    if (verifyCommandLine) {
      const session = await browser.newBrowserCDPSession();
      const { arguments: command } = await session.send("Browser.getBrowserCommandLine");
      assert.ok(command.length > 0, "packaged Chromium command line was empty");
      assert.ok(!command.includes("--no-sandbox"));
      assert.ok(command.includes("--force-webrtc-ip-handling-policy=disable_non_proxied_udp"));
    }
    await page.goto("about:blank");
    const packet = new Promise((resolveReceived) => {
      udp.once("message", () => {
        clearTimeout(timer);
        resolveReceived(true);
      });
      timer = setTimeout(() => resolveReceived(false), 1_500);
    });
    await page.evaluate(async (port) => {
      const peer = new RTCPeerConnection({ iceServers: [{ urls: `stun:127.0.0.1:${port}` }] });
      peer.createDataChannel("probe");
      await peer.setLocalDescription(await peer.createOffer());
      await new Promise((resolveIce) => setTimeout(resolveIce, 1_000));
      peer.close();
    }, udp.address().port);
    return await packet;
  } finally {
    if (timer) clearTimeout(timer);
    await browser?.close();
    udp.close();
  }
}

const diagnosticOptions = { ...options, args: [...options.args, "--enable-automation"] };
const unsafeOptions = {
  ...diagnosticOptions,
  args: diagnosticOptions.args.filter((argument) => !argument.startsWith("--force-webrtc-ip-handling-policy=")),
};
assert.equal(await probeWebRtc(unsafeOptions), true, "WebRTC positive control did not reach loopback UDP");
assert.equal(
  await probeWebRtc(diagnosticOptions, true),
  false,
  "WebRTC bypassed the browser proxy over loopback UDP",
);

const crashBrowser = await chromium.launch(options);
let crashTimer;
let trackedProcesses = [];
const commandFor = (pid) => {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
try {
  const disconnected = new Promise((resolveDisconnected, rejectDisconnected) => {
    crashBrowser.once("disconnected", resolveDisconnected);
    crashTimer = setTimeout(() => rejectDisconnected(new Error("killed Chromium did not exit")), 5_000);
  });
  const session = await crashBrowser.newBrowserCDPSession();
  const { processInfo } = await session.send("SystemInfo.getProcessInfo");
  const browserProcess = processInfo.find(({ type }) => type === "browser");
  assert.ok(browserProcess?.id, "packaged Chromium PID was unavailable");
  trackedProcesses = processInfo
    .map(({ id }) => ({ id, command: commandFor(id) }))
    .filter(({ command }) => command.length > 0);
  assert.ok(trackedProcesses.some(({ id }) => id === browserProcess.id));
  process.kill(browserProcess.id, "SIGKILL");
  await disconnected;
  for (let attempt = 0; attempt < 50 && trackedProcesses.some(({ id }) => alive(id)); attempt += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  const survivors = trackedProcesses.filter(({ id, command }) => alive(id) && commandFor(id) === command);
  for (const { id } of survivors) process.kill(id, "SIGKILL");
  assert.deepEqual(survivors, [], "killed Chromium left child processes running");
} finally {
  if (crashTimer) clearTimeout(crashTimer);
  await crashBrowser.close().catch(() => undefined);
}
