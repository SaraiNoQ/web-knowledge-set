import { expect, test } from "@playwright/test";

test("external worker response supplies its own restrictive CSP without relaxing the app", async ({ request }) => {
  const worker = await request.get("/reader-plugin-worker"), shell = await request.get("/");
  expect(worker.status()).toBe(200);
  expect(worker.headers()["content-type"]).toContain("text/javascript");
  expect(worker.headers()["cache-control"]).toBe("no-store");
  const policy = worker.headers()["content-security-policy"];
  expect(policy).toContain("default-src 'none'"); expect(policy).toContain("connect-src 'none'");
  expect(policy).toContain("script-src blob:"); expect(policy).toContain("worker-src blob:");
  expect(policy).not.toMatch(/unsafe-eval|unsafe-inline/u);
  expect(shell.headers()["content-security-policy"]).toContain("frame-src 'none'");
  expect(shell.headers()["content-security-policy"]).toContain("script-src 'self'");
  expect(shell.headers()["content-security-policy"]).not.toContain("unsafe-eval");
  const head = await request.head("/reader-plugin-worker"); expect(head.status()).toBe(200); expect(await head.body()).toHaveLength(0);
});

test("untrusted worker code cannot recover origin storage, native APIs, communication constructors or a navigation context", async ({ page }) => {
  const attempts = new Map<string, string | null>(), responses: string[] = [];
  page.on("request", (request) => { if (request.url().includes("plugin-egress")) attempts.set(request.url(), null); });
  page.on("requestfailed", (request) => { if (request.url().includes("plugin-egress")) attempts.set(request.url(), request.failure()?.errorText ?? "unknown failure"); });
  page.on("response", (response) => { if (response.url().includes("plugin-egress")) responses.push(response.url()); });
  await page.goto("/");
  const report = await page.evaluate(async () => {
    const script = String.raw`"use strict";
      (async () => {
        const names = ["fetch","XMLHttpRequest","WebSocket","WebSocketStream","WebTransport","EventSource","Worker","SharedWorker","BroadcastChannel","indexedDB","caches","navigator","importScripts","postMessage","close","__TAURI_INTERNALS__","__TAURI__"];
        const blocked = {}, recovered = [];
        for (const name of names) {
          blocked[name] = self[name] === undefined;
          for (let owner = self; owner; owner = Object.getPrototypeOf(owner)) {
            const descriptor = Object.getOwnPropertyDescriptor(owner, name);
            if (!descriptor) continue;
            try { const value = descriptor.get ? descriptor.get.call(self) : descriptor.value; if (value !== undefined) recovered.push(name); } catch {}
          }
          try { Object.defineProperty(self, name, { value: () => 'restored' }); } catch {}
          blocked[name] &&= self[name] === undefined;
        }
        const result = { blocked, recovered, origin: self.origin, dom: [typeof document,typeof window,typeof localStorage], native: typeof __TAURI_INTERNALS__, frozen: Object.isFrozen(zhiye) && Object.isFrozen(zhiye.storage), navigation: false, evaluate: false, remoteImport: '', font: '' };
        const previous = location.href;
        try { location.href = self.origin + '/health?plugin-egress-navigation'; } catch {}
        result.navigation = location.href !== previous;
        try { Function('return 1')(); result.evaluate = true; } catch {}
        try { await import(self.origin + '/health?plugin-egress-import'); result.remoteImport = 'loaded'; } catch { result.remoteImport = 'blocked'; }
        if (typeof FontFace === 'function') {
          try { await new FontFace('plugin-egress', 'url(' + self.origin + '/health?plugin-egress-font)').load(); result.font = 'loaded'; } catch { result.font = 'blocked'; }
        } else result.font = 'unavailable';
        zhiye.render({ text: JSON.stringify(result), fields: [], actions: [] });
      })();`;
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const worker = new Worker("/reader-plugin-worker"), channel = new MessageChannel();
      let value: Record<string, unknown> | null = null, ready = false;
      const stop = () => { clearTimeout(timer); channel.port1.close(); worker.terminate(); };
      const timer = setTimeout(() => { stop(); reject(new Error("isolated worker did not finish")); }, 7000);
      worker.onerror = (event) => { stop(); reject(new Error(event.message)); };
      worker.onmessage = () => { stop(); reject(new Error("trusted bootstrap reported a failed child")); };
      channel.port1.onmessage = (event) => {
        if (typeof event.data !== "string") { stop(); reject(new Error("unbounded non-JSON transport")); return; }
        const data = JSON.parse(event.data);
        if (data.type === "failed") { stop(); reject(new Error("isolated script failed")); return; }
        if (data.type === "ready") ready = true;
        if (data.type === "view") value = JSON.parse(data.view.text) as Record<string, unknown>;
        if (ready && value) { stop(); resolve(value); }
      };
      channel.port1.start(); worker.postMessage({ type: "start", script }, [channel.port2]);
    });
  });
  expect(Object.entries(report.blocked as Record<string, boolean>).filter(([, blocked]) => !blocked)).toEqual([]);
  expect(report.recovered).toEqual([]); expect(report.dom).toEqual(["undefined", "undefined", "undefined"]);
  expect(report.origin).toBe(new URL(page.url()).origin);
  expect(report.native).toBe("undefined"); expect(report.frozen).toBe(true); expect(report.navigation).toBe(false); expect(report.evaluate).toBe(false);
  expect(report.remoteImport).toBe("blocked"); expect(["blocked", "unavailable"]).toContain(report.font);
  expect(responses).toEqual([]);
  for (const [url, failure] of attempts) expect(failure, url).toMatch(/CSP|CONTENT_BLOCKED|CONTENT_POLICY|NS_ERROR_DOM_BAD_URI/iu);
});

test("terminating the trusted parent stops an infinite plugin loop and releases the page", async ({ page }) => {
  await page.goto("/");
  const outcome = await page.evaluate(async () => {
    const worker = new Worker("/reader-plugin-worker"), channel = new MessageChannel();
    let views = 0, ready = false, markReady = () => {}, markLoop = () => {};
    const initialized = new Promise<void>((resolve) => { markReady = resolve; }), looping = new Promise<void>((resolve) => { markLoop = resolve; });
    channel.port1.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      const data = JSON.parse(event.data);
      if (data.type === "view") views += 1;
      if (data.type === "ready") ready = true;
      if (views && ready) markReady();
      if (data.type === "request" && data.method === "capabilities") markLoop();
    };
    channel.port1.start();
    worker.postMessage({ type: "start", script: "zhiye.render({text:'ready for action',fields:[],actions:[]});zhiye.onAction(()=>{zhiye.capabilities();while(true){}});" }, [channel.port2]);
    let timer = 0;
    const deadline = new Promise<never>((_, reject) => { timer = window.setTimeout(() => reject(new Error("plugin did not enter its action loop")), 5000); });
    try {
      await Promise.race([initialized, deadline]);
      channel.port1.postMessage({ type: "action", id: "loop", values: {} });
      // The capabilities request is posted synchronously immediately before the infinite loop.
      await Promise.race([looping, deadline]);
      const started = performance.now(); worker.terminate(); channel.port1.close();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return { views, entered: true, elapsed: performance.now() - started, responsive: true };
    } finally { clearTimeout(timer); worker.terminate(); channel.port1.close(); }
  });
  expect(outcome.views).toBe(1); expect(outcome.entered).toBe(true); expect(outcome.responsive).toBe(true); expect(outcome.elapsed).toBeLessThan(1000);
});

test("the trusted child transport rejects oversized views before cloning them into the page", async ({ page }) => {
  await page.goto("/");
  const outcome = await page.evaluate(async () => await new Promise<{ largest: number; text: string }>((resolve, reject) => {
    const worker = new Worker("/reader-plugin-worker"), channel = new MessageChannel();
    let largest = 0;
    const stop = () => { clearTimeout(timer); channel.port1.close(); worker.terminate(); };
    const timer = setTimeout(() => { stop(); reject(new Error("budget test timed out")); }, 5000);
    worker.onerror = (event) => { stop(); reject(new Error(event.message)); };
    channel.port1.onmessage = (event) => {
      if (typeof event.data !== "string") { stop(); reject(new Error("non-JSON plugin transport")); return; }
      largest = Math.max(largest, new TextEncoder().encode(event.data).byteLength);
      const data = JSON.parse(event.data);
      if (data.type === "view") { stop(); resolve({ largest, text: data.view.text }); }
      if (data.type === "failed") { stop(); reject(new Error("oversized payload was not caught inside plugin")); }
    };
    channel.port1.start(); worker.postMessage({ type: "start", script: "let blocked=false;try{zhiye.render({text:'x'.repeat(70000),fields:[],actions:[]});}catch{blocked=true;}zhiye.render({text:blocked?'oversize blocked':'budget bypass',fields:[],actions:[]});" }, [channel.port2]);
  }));
  expect(outcome.text).toBe("oversize blocked"); expect(outcome.largest).toBeLessThanOrEqual(64 * 1024);
});

test("poisoning message event getters cannot recover the private SDK port", async ({ page }) => {
  await page.goto("/");
  const report = await page.evaluate(() => new Promise<{ leaked: boolean; response: string }>((resolve, reject) => {
    const worker = new Worker("/reader-plugin-worker"), channel = new MessageChannel();
    const stop = () => { clearTimeout(timer); channel.port1.close(); worker.terminate(); };
    const timer = setTimeout(() => { stop(); reject(new Error("private port test timed out")); }, 7000);
    worker.onerror = () => { stop(); reject(new Error("isolated worker failed")); };
    channel.port1.onmessage = (event) => {
      const packet = JSON.parse(event.data);
      if (packet.type === "request") channel.port1.postMessage({ type: "result", id: packet.id, value: "bounded result" });
      if (packet.type === "view") { stop(); resolve(JSON.parse(packet.view.text)); }
    };
    channel.port1.start();
    worker.postMessage({ type: "start", script: `
      const original = Object.getOwnPropertyDescriptor(MessageEvent.prototype,'data').get;
      let leaked = false;
      Object.defineProperty(MessageEvent.prototype,'data',{get(){if(this.currentTarget instanceof MessagePort || this.ports.length) leaked=true;return original.call(this);}});
      zhiye.capabilities().then(response=>zhiye.render({text:JSON.stringify({leaked,response}),fields:[],actions:[]}));
    ` }, [channel.port2]);
  }));
  expect(report).toEqual({ leaked: false, response: "bounded result" });
});
