/* Loaded only by benchmark-macos-map.mjs, before the unmodified production bundle. */
(() => {
  "use strict";
  const metrics = { frames: [], resources: [], workers: [], errors: [], contextsCreated: 0, contextsReleased: 0, buffers: 0, nodes2D: 0, nodes3D: 0, longTasks: [], visibility: [] };
  const visibility = () => ({ atMs: performance.now(), visibility: document.visibilityState, focused: document.hasFocus() });
  for (const event of ["visibilitychange", "focus", "blur"]) window.addEventListener(event, () => metrics.visibility.push({ event, ...visibility() }));
  const instrumentation = new URL(document.currentScript.src);
  const start = performance.now(), count = Number(new URL(location.href).searchParams.get("benchmark") || 1000), dwellMs = Number(instrumentation.searchParams.get("dwell") || 0), waves = Number(instrumentation.searchParams.get("waves") || 1);
  let measuring = false, first2D = null, first3D = null;
  const nativeFetch = window.fetch.bind(window);
  const send = async (stage, data) => {
    const response = await nativeFetch("/__map-benchmark/result", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stage, count, atMs: performance.now(), ...data }) });
    if (!response.ok) throw new Error(`Benchmark recorder rejected ${stage}: ${response.status}`);
    return response.json();
  };
  const timeout = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const wait = async (condition, description, milliseconds = 30000) => {
    const begin = performance.now();
    while (!condition()) { if (performance.now() - begin > milliseconds) throw new Error(`Timed out: ${description}`); await timeout(20); }
  };
  const button = (label, scope = document) => [...(scope?.querySelectorAll("button") || [])].find((item) => item.textContent.trim() === label || item.getAttribute("aria-label") === label);
  const click = async (label, scope = document) => { await wait(() => button(label, scope), label); button(label, scope).click(); };
  const nativeWorker = window.Worker;
  window.Worker = class extends nativeWorker {
    constructor(url, options) {
      super(url, options); this.benchmarkUrl = String(url); this.benchmarkPending = new Map();
      this.addEventListener("message", ({ data }) => { const pending = this.benchmarkPending.get(data.requestId); if (pending) { metrics.workers.push({ url: this.benchmarkUrl, ...pending, endMs: performance.now(), positions: data.positions?.length / 3 || null, error: data.error || null }); this.benchmarkPending.delete(data.requestId); } });
    }
    postMessage(message, ...rest) { this.benchmarkPending.set(message.requestId, { mode: message.mode || "layout", startMs: performance.now() }); super.postMessage(message, ...rest); }
  };
  window.fetch = async (...args) => {
    const input = args[0], url = new URL(typeof input === "string" ? input : input.url || input, location.href), begin = performance.now();
    const headers = new Headers(args[1]?.headers || input.headers);
    if (url.origin === location.origin && url.pathname.startsWith("/api/knowledge-map")) headers.set("X-Zhiye-Benchmark-Size", String(count));
    const result = await nativeFetch(input, { ...args[1], headers });
    if (url.pathname.startsWith("/api/knowledge-map")) metrics.resources.push({ url: url.pathname, startMs: begin, endMs: performance.now(), status: result.status });
    return result;
  };
  if (PerformanceObserver.supportedEntryTypes?.includes("longtask")) new PerformanceObserver((list) => metrics.longTasks.push(...list.getEntries().map(({ startTime, duration }) => ({ startTime, duration })))).observe({ type: "longtask", buffered: true });
  window.addEventListener("error", (event) => metrics.errors.push(event.message));
  const isMap2D = (context) => context.canvas.closest(".map-canvas-inner") && !context.canvas.closest(".map-3d");
  const clear2D = CanvasRenderingContext2D.prototype.clearRect, fill2D = CanvasRenderingContext2D.prototype.fill;
  CanvasRenderingContext2D.prototype.clearRect = function (...args) { if (isMap2D(this)) metrics.nodes2D = 0; return Reflect.apply(clear2D, this, args); };
  CanvasRenderingContext2D.prototype.fill = function (...args) { if (isMap2D(this)) { first2D ??= performance.now(); metrics.nodes2D += 1; } return Reflect.apply(fill2D, this, args); };
  if (window.WebGL2RenderingContext) {
    const getContext = HTMLCanvasElement.prototype.getContext, contexts = new WeakSet();
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      const result = Reflect.apply(getContext, this, [type, ...args]);
      if (type === "webgl2" && result && !contexts.has(result)) { contexts.add(result); metrics.contextsCreated += 1; this.addEventListener("webglcontextlost", () => { metrics.contextsReleased += 1; }, { once: true }); }
      return result;
    };
    const isMap3D = (gl) => gl.canvas.isConnected && gl.canvas.closest(".map-3d");
    const clear = WebGL2RenderingContext.prototype.clear;
    WebGL2RenderingContext.prototype.clear = function (...args) { if (isMap3D(this)) { first3D ??= performance.now(); metrics.nodes3D = 0; if (measuring) metrics.frames.push(performance.now()); } return Reflect.apply(clear, this, args); };
    for (const method of ["drawArrays", "drawElementsInstanced", "drawArraysInstanced"]) {
      const draw = WebGL2RenderingContext.prototype[method];
      WebGL2RenderingContext.prototype[method] = function (...args) { if (isMap3D(this)) { if (method === "drawArrays" && args[0] === this.POINTS) metrics.nodes3D += args[2]; else if (method !== "drawArrays") metrics.nodes3D += args.at(-1); } return Reflect.apply(draw, this, args); };
    }
    const buffers = new WeakSet(), createBuffer = WebGL2RenderingContext.prototype.createBuffer, deleteBuffer = WebGL2RenderingContext.prototype.deleteBuffer;
    WebGL2RenderingContext.prototype.createBuffer = function () { const value = createBuffer.call(this); if (value) { buffers.add(value); metrics.buffers += 1; } return value; };
    WebGL2RenderingContext.prototype.deleteBuffer = function (value) { if (value && buffers.has(value)) { buffers.delete(value); metrics.buffers -= 1; } return deleteBuffer.call(this, value); };
  }
  const summary = (values) => {
    const ordered = values.toSorted((a, b) => a - b);
    return { samples: values.length, medianMs: ordered[Math.floor(ordered.length / 2)] ?? null, p95Ms: ordered[Math.ceil(ordered.length * .95) - 1] ?? null, maxMs: ordered.at(-1) ?? null };
  };
  const dimension = async (name) => {
    await click(name, document.querySelector(".map-dimension-switch"));
    await wait(() => name === "3D" ? document.querySelector(".map-3d canvas") && document.querySelector('.map-3d[aria-busy="false"]') && metrics.nodes3D > 0 : !document.querySelector(".map-3d") && document.querySelector(".map-canvas-inner canvas"), `${name} renderer`);
  };
  const interaction = async (kind) => {
    await wait(() => document.visibilityState === "visible" && document.hasFocus(), `${kind} foreground`);
    const canvas = document.querySelector(".map-3d canvas"), rect = canvas.getBoundingClientRect(), times = [];
    const labels = [...document.querySelectorAll(".map-3d-labels span")].filter((label) => !label.hidden), dragged = kind === "drag" ? labels[0] : null, stable = kind === "drag" ? labels[1] : null;
    const coordinates = (label) => { const parts = label?.style.transform.match(/translate\(([-\d.e]+)px,\s*([-\d.e]+)px\)/u); return parts ? [+parts[1], +parts[2]] : [NaN, NaN]; };
    const draggedBefore = coordinates(dragged), stableBefore = coordinates(stable), point = dragged?.getBoundingClientRect();
    // Synthetic events preserve the renderer/control code path; trusted picking is tested separately.
    const capture = canvas.setPointerCapture, release = canvas.releasePointerCapture;
    canvas.setPointerCapture = () => {}; canvas.releasePointerCapture = () => {};
    const pointer = (type, x, y) => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, pointerType: "mouse", buttons: type === "pointerup" ? 0 : 1, button: 0, clientX: x, clientY: y }));
    const x = point ? point.left - 10 : rect.left + 12, y = point ? point.top : rect.top + 20;
    if (kind !== "zoom") pointer("pointerdown", x, y);
    metrics.frames = []; measuring = true;
    const begin = performance.now(), conditions = [visibility()];
    await new Promise((resolve) => {
      const frame = (now) => {
        times.push(now);
        if (document.visibilityState !== "visible" || !document.hasFocus()) conditions.push(visibility());
        const elapsed = now - begin;
        if (kind !== "zoom") pointer("pointermove", x + Math.sin(elapsed / 300) * 100, y + Math.cos(elapsed / 300) * 70);
        else canvas.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: Math.sin(elapsed / 250) * 10 }));
        if (elapsed < 3000) requestAnimationFrame(frame); else resolve();
      }; requestAnimationFrame(frame);
    });
    measuring = false;
    if (kind !== "zoom") pointer("pointerup", x, y);
    canvas.setPointerCapture = capture; canvas.releasePointerCapture = release;
    const frames = metrics.frames.slice(), intervals = frames.slice(1).map((time, index) => time - frames[index]);
    const moved = coordinates(dragged), fixed = coordinates(stable), cameraDisplacementPx = Math.hypot(fixed[0] - stableBefore[0], fixed[1] - stableBefore[1]);
    return { kind, input: "synthetic DOM pointer/wheel events", foreground: conditions.every((state) => state.visibility === "visible" && state.focused), conditions, durationMs: performance.now() - begin, frames: frames.length, fps: frames.length > 1 ? (frames.length - 1) * 1000 / (frames.at(-1) - frames[0]) : 0, ...summary(intervals), scheduler: summary(times.slice(1).map((time, index) => time - times[index])), ...(kind === "drag" ? { nodeMoved: Math.hypot(moved[0] - draggedBefore[0], moved[1] - draggedBefore[1]) >= 4, cameraStable: cameraDisplacementPx < .5, cameraDisplacementPx, nodes: metrics.nodes3D } : {}) };
  };
  const pluginProbe = async () => {
    const response = await nativeFetch("/reader-plugin-worker"), policy = response.headers.get("Content-Security-Policy");
    if (!response.ok) throw new Error(`Plugin worker endpoint: ${response.status}`);
    return new Promise((resolve, reject) => {
      const worker = new nativeWorker("/reader-plugin-worker"), channel = new MessageChannel();
      const stop = () => { clearTimeout(timer); channel.port1.close(); worker.terminate(); };
      const timer = setTimeout(() => { stop(); reject(new Error("Plugin isolation probe timeout")); }, 7000);
      worker.onerror = (event) => { stop(); reject(new Error(event.message)); };
      worker.onmessage = () => { stop(); reject(new Error("Plugin isolation bootstrap failed")); };
      channel.port1.onmessage = (event) => {
        if (typeof event.data !== "string") { stop(); reject(new Error("Plugin isolation transport is not JSON")); return; }
        const value = JSON.parse(event.data);
        if (value.type === "failed") { stop(); reject(new Error("Plugin probe script failed")); }
        if (value.type === "view") { stop(); resolve({ policy, ...JSON.parse(value.view.text) }); }
      };
      channel.port1.start(); worker.postMessage({ type: "start", script: `(async () => {
        const names=["fetch","XMLHttpRequest","WebSocket","Worker","SharedWorker","BroadcastChannel","indexedDB","caches","navigator","importScripts","postMessage","__TAURI_INTERNALS__","__TAURI__"];
        const blocked=Object.fromEntries(names.map(name=>[name,self[name]===undefined]));
        let remoteImport="",evaluate=false;
        try{Function("return 1")();evaluate=true;}catch{}
        try{await import(self.origin+"/__map-benchmark/probe-egress");remoteImport="loaded";}catch{remoteImport="blocked";}
        zhiye.render({text:JSON.stringify({blocked,dom:[typeof document,typeof window,typeof localStorage],native:typeof __TAURI_INTERNALS__,remoteImport,evaluate}),fields:[],actions:[]});
      })();` }, [channel.port2]);
    });
  };
  async function run() {
    if (count === 1000) { try { await send("plugin-isolation", { probe: await pluginProbe() }); } catch (error) { await send("plugin-isolation", { error: error.message }); } }
    await wait(() => button("知识地图", document.querySelector('[aria-label="工作台导航"]')), "workspace ready");
    const openStart = performance.now(); await click("知识地图", document.querySelector('[aria-label="工作台导航"]'));
    await wait(() => first2D !== null && !document.querySelector(".map-loading"), "first 2D frame");
    await wait(() => !document.querySelector(".map-semantic-status") || count > 1000, "semantic worker complete");
    const first2DReadyMs = performance.now() - openStart;
    const threeStart = performance.now(); await dimension("3D");
    const first3DReadyMs = performance.now() - threeStart;
    const gl = document.querySelector(".map-3d canvas").getContext("webgl2"), debug = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    const base = { engine: navigator.userAgent, tauri: "__TAURI_INTERNALS__" in globalThis, viewport: [innerWidth, innerHeight], pixelRatio: devicePixelRatio, renderer, dwellMs, waves, first2DReadyMs, first3DReadyMs, first2DAtMs: first2D - start, first3DAtMs: first3D - start, nodes2D: metrics.nodes2D, nodes3D: metrics.nodes3D, resourceTimings: performance.getEntriesByType("resource").filter((entry) => /KnowledgeMap|worker/.test(entry.name)).map(({ name, startTime, duration, transferSize }) => ({ name: new URL(name).pathname, startTime, duration, transferSize })), requests: metrics.resources, workers: metrics.workers, longTaskSupport: PerformanceObserver.supportedEntryTypes?.includes("longtask") || false };
    await send("loaded", base);
    if (count === 1000) {
      const interactions = [await interaction("rotate"), await interaction("zoom"), await interaction("drag")];
      const details = document.querySelector(".map-accessible-list"); details.open = true;
      await wait(() => details.querySelectorAll("li button").length > 0, "accessible documents");
      const detailTimes = [];
      for (const item of [...details.querySelectorAll("li button")].slice(0, 20)) {
        const title = [...item.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join("").trim();
        const begin = performance.now(); item.click();
        await wait(() => document.querySelector(".knowledge-map-detail h3")?.textContent === title, "selected detail");
        detailTimes.push(performance.now() - begin);
      }
      const close = button("关闭详情"); if (close) close.click();
      details.open = false;
      await send("interactions", { interactions, detail: summary(detailTimes) });
      for (let wave = 1; wave <= waves; wave += 1) {
        await dimension("3D"); await send("wave-start", { wave });
        for (let index = 0; index < 30; index += 1) {
        await dimension("2D"); await wait(() => metrics.buffers === 0 && metrics.contextsReleased === metrics.contextsCreated, "WebGL release");
        await timeout(dwellMs);
        await send("toggle", { wave, cycle: index + 1, phase: "2D", buffers: metrics.buffers, contextsCreated: metrics.contextsCreated, contextsReleased: metrics.contextsReleased });
        await dimension("3D");
        await timeout(dwellMs);
        await send("toggle", { wave, cycle: index + 1, phase: "3D", buffers: metrics.buffers, contextsCreated: metrics.contextsCreated, contextsReleased: metrics.contextsReleased });
        }
        await dimension("2D");
        for (const idleMs of [0, 1000, 5000, 15000]) { await timeout(idleMs); await send("cooldown", { wave, idleMs, buffers: metrics.buffers, contextsCreated: metrics.contextsCreated, contextsReleased: metrics.contextsReleased }); }
      }
    } else {
      const aggregateNodes = metrics.nodes3D;
      const details = document.querySelector(".map-accessible-list"); details.open = true;
      await wait(() => details.querySelectorAll("li button").length === 50, "bounded list");
      details.querySelector("li button").click(); await click("聚焦关联");
      await wait(() => document.querySelector('.map-3d[aria-busy="false"]') && metrics.nodes3D < aggregateNodes && metrics.nodes3D > 0, "local neighborhood");
      await send("large-library", { aggregateNodes, listRows: details.querySelectorAll("li button").length, localNodes: metrics.nodes3D });
    }
    await send("complete", { errors: metrics.errors, longTasks: metrics.longTasks, visibility: metrics.visibility, contextsCreated: metrics.contextsCreated, contextsReleased: metrics.contextsReleased, buffers: metrics.buffers });
    if (count === 1000) location.href = `${location.origin}/?benchmark=10000`;
  }
  run().catch((error) => { void send("failed", { error: `${error.message}\n${error.stack || ""}`, errors: metrics.errors, text: document.body.innerText.slice(-6000), metrics, first2D, first3D }); });
})();
