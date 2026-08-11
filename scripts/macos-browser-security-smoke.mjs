import assert from "node:assert/strict";
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

const unsafeOptions = {
  ...options,
  args: options.args.filter((argument) => !argument.startsWith("--force-webrtc-ip-handling-policy=")),
};
assert.equal(await probeWebRtc(unsafeOptions), true, "WebRTC positive control did not reach loopback UDP");
assert.equal(
  await probeWebRtc(options, true),
  false,
  "WebRTC bypassed the browser proxy over loopback UDP",
);
