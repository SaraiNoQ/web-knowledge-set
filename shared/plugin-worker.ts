const runtime = String.raw`(() => {
  "use strict";
  const listen = self.addEventListener.bind(self), unlisten = self.removeEventListener.bind(self);
  const schedule = self.setTimeout.bind(self), repeat = self.setInterval.bind(self), unschedule = self.clearTimeout.bind(self);
  const loadScript = self.importScripts.bind(self);
  const stringify = JSON.stringify.bind(JSON), encode = new TextEncoder().encode.bind(new TextEncoder());
  const define = Object.defineProperty, freeze = Object.freeze, prototype = Object.getPrototypeOf;
  for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "WebSocketStream", "WebTransport", "EventSource", "RTCPeerConnection", "webkitRTCPeerConnection", "Worker", "SharedWorker", "BroadcastChannel", "indexedDB", "caches", "navigator", "importScripts", "postMessage", "close", "__TAURI_INTERNALS__", "__TAURI__"]) {
    for (let owner = self; owner; owner = prototype(owner)) {
      if (Object.hasOwn(owner, name)) define(owner, name, { value: undefined, writable: false, configurable: false });
    }
    define(self, name, { value: undefined, writable: false, configurable: false });
    if (self[name] !== undefined) throw new Error("Plugin isolation unavailable");
  }
  const initialize = (event) => {
    if (event.data?.type !== "initialize" || event.ports.length !== 1 || typeof event.data.scriptUrl !== "string" || !event.data.scriptUrl.startsWith("blob:")) return;
    event.stopImmediatePropagation();
    unlisten("message", initialize);
    const port = event.ports[0], post = port.postMessage.bind(port), pending = new Map();
    const pack = (value) => {
      const text = stringify(value);
      if (!text || text.length > 64000 || encode(text).byteLength > 65536) throw new Error("插件消息超过 64 KiB。");
      return text;
    };
    const send = (value) => post(pack(value));
    let failed = false;
    listen("unhandledrejection", (event) => { event.preventDefault(); failed = true; send({ type: "failed" }); });
    let queuedView = "", viewTimer = 0;
    const render = (view) => { queuedView = pack({ type: "view", view }); if (!viewTimer) viewTimer = schedule(() => { viewTimer = 0; post(queuedView); }, 80); };
    let sequence = 0, action = null;
    const call = (method, args = {}, onText) => new Promise((resolve, reject) => {
      if (pending.size >= 4) { reject(new Error("同时请求过多，请稍候。")); return; }
      const id = String(++sequence), timer = schedule(() => { pending.delete(id); send({ type: "cancel", id }); reject(new Error("请求超时。")); }, 65000);
      pending.set(id, { resolve, reject, onText, timer }); send({ type: "request", id, method, args });
    });
    define(self, "zhiye", { configurable: false, writable: false, value: freeze({
      selection: () => call("selection.get"), capabilities: () => call("capabilities"),
      storage: freeze({ get: (key, fallback = null) => call("storage.get", { key, fallback }), set: (key, value) => call("storage.set", { key, value }) }),
      translate: (token, language, onText) => call("translation.request", { token, language }, onText),
      saveExcerpt: (token, translation = "", note = "") => call("annotations.create", { token, translation, note }),
      close: () => call("close"), render,
      onAction: (listener) => { if (typeof listener !== "function") throw new Error("操作监听器无效。"); action = listener; }
    }) });
    port.onmessage = (event) => {
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (data.type === "action" && typeof action === "function") { Promise.resolve().then(() => action(data.id, data.values)).catch(() => send({ type: "failed" })); return; }
      const request = pending.get(data.id); if (!request) return;
      if (data.type === "chunk") { if (typeof data.text === "string" && typeof request.onText === "function") request.onText(data.text); return; }
      if (data.type !== "result") return;
      unschedule(request.timer); pending.delete(data.id);
      if (data.error) request.reject(new Error(String(data.error))); else request.resolve(data.value);
    };
    port.start(); repeat(() => send({ type: "heartbeat" }), 2000);
    try { loadScript(event.data.scriptUrl); URL.revokeObjectURL(event.data.scriptUrl); schedule(() => { if (!failed) send({ type: "ready" }); }, 0); }
    catch { failed = true; send({ type: "failed" }); }
  };
  listen("message", initialize);
})();`;

// A blob worker inherits this worker's restrictive response CSP, never the application's API access.
export function pluginWorkerDocument() {
  const script = `"use strict"; let child; self.onmessage = (event) => {
    if (child || event.data?.type !== "start" || typeof event.data.script !== "string" || event.data.script.length > 1048576 || event.ports.length !== 1) return;
    const url = URL.createObjectURL(new Blob([${JSON.stringify(runtime)}], {type:"text/javascript"}));
    const scriptUrl = URL.createObjectURL(new Blob([event.data.script], {type:"text/javascript"}));
    child = new Worker(url); URL.revokeObjectURL(url);
    child.onerror = () => { child.terminate(); self.postMessage({type:"failed"}); };
    child.postMessage({type:"initialize",scriptUrl}, [event.ports[0]]);
    setTimeout(() => URL.revokeObjectURL(scriptUrl), 65000);
  };`;
  return { script, headers: {
    "Content-Type": "text/javascript; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; connect-src 'none'; script-src blob:; worker-src blob:; object-src 'none'; base-uri 'none'",
    "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
  } };
}
