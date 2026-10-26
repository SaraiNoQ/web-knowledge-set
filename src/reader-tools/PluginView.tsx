import { useEffect, useRef, useState } from "react";
import { TRANSLATION_LANGUAGES, type TranslationLanguage } from "../../shared/types";
import type { ReaderSelection } from "../../shared/reader-tools";
import type { ReaderToolApi, ReaderToolViewProps } from "./runtime";
import type { VerifiedPluginPackage } from "./plugin-package";
import { pluginObject } from "./plugin-package";
import { parsePluginRequest, parsePluginView, pluginMessageBytes, type PluginView as View } from "./plugin-protocol";
import { Button, Input, Textarea } from "../components/ui/Controls";

function startPlugin(pkg: VerifiedPluginPackage, api: ReaderToolApi | null, update: (view: View) => void, ready: () => void, fail: (message: string) => void) {
  const worker = new Worker("/reader-plugin-worker", { name: pkg.manifest.id }), channel = new MessageChannel(), port = channel.port1;
  const requests = new Map<string, AbortController>(), used = new Set<string>();
  let stopped = false, initialized = false, lastHeartbeat = Date.now(), windowStart = Date.now(), messages = 0, actions = 0, receivedBytes = 0;
  let selectionToken = "", selectionKey = "", lastAction = 0;
  const stop = () => { if (stopped) return; stopped = true; clearTimeout(startup); clearInterval(watchdog); for (const controller of requests.values()) controller.abort(); requests.clear(); port.close(); worker.terminate(); };
  const failure = (message = "插件已停止，正文仍可继续阅读。") => { if (stopped) return; stop(); fail(message); };
  const send = (value: unknown) => { if (!stopped) { pluginMessageBytes(value); port.postMessage(value); } };
  const selection = (token?: unknown): ReaderSelection | null => {
    if (!api || document.querySelector("dialog[open]")) throw new Error("当前不能读取选区。");
    const current = api.selection(), key = current ? JSON.stringify([current.documentId, current.revision, current.anchor]) : "";
    if (key !== selectionKey) { selectionKey = key; selectionToken = crypto.randomUUID(); }
    if (token !== undefined && (token !== selectionToken || !current)) throw new Error("选区已变化，请重新读取选区。");
    return current;
  };
  const startup = window.setTimeout(() => failure("插件未能启动，已停止。"), 5000);
  const watchdog = window.setInterval(() => { if (document.visibilityState === "visible" && Date.now() - lastHeartbeat > 12000) failure("插件长时间没有响应，已停止。" ); }, 2000);
  worker.onerror = () => failure("插件启动失败，已停止。");
  worker.onmessage = () => failure("插件执行失败，已停止。");
  port.onmessage = (event) => {
    if (stopped) return;
    try {
      if (typeof event.data !== "string" || event.data.length > 64000) throw new Error("插件消息格式无效或过长。");
      const data: unknown = JSON.parse(event.data); pluginMessageBytes(data);
      if (Date.now() - windowStart >= 10000) { windowStart = Date.now(); messages = 0; actions = 0; receivedBytes = 0; }
      receivedBytes += new TextEncoder().encode(event.data).byteLength;
      if (++messages > 160 || receivedBytes > 2 * 1024 * 1024) throw new Error("插件请求过于频繁，已停止。");
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("插件消息格式无效。");
      const packet = data as Record<string, unknown>;
      if (packet.type === "heartbeat") { lastHeartbeat = Date.now(); return; }
      if (packet.type === "failed") { failure("插件执行失败，已停止。"); return; }
      if (packet.type === "ready" && !initialized) { initialized = true; clearTimeout(startup); lastHeartbeat = Date.now(); ready(); return; }
      if (packet.type === "view") { update(parsePluginView(packet.view)); return; }
      if (packet.type === "cancel" && typeof packet.id === "string") { requests.get(packet.id)?.abort(); return; }
      const request = parsePluginRequest(data);
      if (used.has(request.id) || used.size >= 256 || requests.size >= 4) throw new Error("插件请求重复或超过本次运行预算，已停止。");
      used.add(request.id); const controller = new AbortController(); requests.set(request.id, controller);
      void (async () => {
        try {
          if (!api || !initialized || document.querySelector("dialog[open]")) throw new Error("插件尚未启用或当前操作不可用。");
          let value: unknown = null;
          switch (request.method) {
            case "capabilities": pluginObject(request.args, []); value = await api.capabilities(); break;
            case "selection.get": { pluginObject(request.args, []); const current = selection(); value = current ? { token: selectionToken, selection: current } : null; break; }
            case "storage.get": { const args = pluginObject(request.args, ["key", "fallback"]); if (typeof args.key !== "string") throw new Error("设置名称无效。"); value = api.storage.get(args.key, args.fallback ?? null); break; }
            case "storage.set": { const args = pluginObject(request.args, ["key", "value"]); if (typeof args.key !== "string") throw new Error("设置名称无效。"); api.storage.set(args.key, args.value); break; }
            case "translation.request": {
              const args = pluginObject(request.args, ["token", "language"]);
              if (typeof args.token !== "string" || !args.token) throw new Error("请先读取当前选区。");
              if (typeof args.language !== "string" || !Object.hasOwn(TRANSLATION_LANGUAGES, args.language)) throw new Error("目标语言无效。");
              if (++actions > 8 || Date.now() - lastAction < 600) throw new Error("翻译请求过于频繁，请稍候。"); lastAction = Date.now();
              const current = selection(args.token)!; let output = "";
              await api.translate(current, args.language as TranslationLanguage, (text) => { output += text; if (output.length > 80000) throw new Error("译文超过插件预算。"); send({ type: "chunk", id: request.id, text }); }, controller.signal); break;
            }
            case "annotations.create": {
              const args = pluginObject(request.args, ["token", "translation", "note"]);
              if (typeof args.token !== "string" || !args.token) throw new Error("请先读取当前选区。");
              if (typeof args.translation !== "string" || args.translation.length > 12000 || typeof args.note !== "string" || args.note.length > 4000) throw new Error("摘录内容无效或过长。");
              if (++actions > 8 || Date.now() - lastAction < 600) throw new Error("保存请求过于频繁，请稍候。"); lastAction = Date.now();
              await api.saveExcerpt(selection(args.token)!, args.translation, args.note); break;
            }
            case "close": pluginObject(request.args, []); api.close(); break;
            default: throw new Error("插件没有此项宿主能力。");
          }
          if (!controller.signal.aborted) send({ type: "result", id: request.id, value });
        } catch (cause) { if (!controller.signal.aborted) send({ type: "result", id: request.id, error: (cause as Error).message.slice(0, 240) }); }
        finally { requests.delete(request.id); }
      })().catch(() => failure());
    } catch (cause) { failure((cause as Error).message); }
  };
  port.start(); worker.postMessage({ type: "start", script: pkg.script }, [channel.port2]);
  return { stop, action: (id: string, values: Record<string, string>) => send({ type: "action", id, values }) };
}

export function PluginView({ pkg, api, active = true, onReady, onFailure }: { pkg: VerifiedPluginPackage; api: ReaderToolApi | null; active?: boolean; onReady?: () => void; onFailure?: (message: string) => void }) {
  const [view, setView] = useState<View | null>(null), [error, setError] = useState(""), [values, setValues] = useState<Record<string, string>>({});
  const callbacks = useRef({ onReady, onFailure }); callbacks.current = { onReady, onFailure };
  const session = useRef<ReturnType<typeof startPlugin> | null>(null);
  useEffect(() => {
    if (!active) return;
    setView(null); setError("");
    try { session.current = startPlugin(pkg, api, (next) => { setView(next); setValues(Object.fromEntries(next.fields.map((field) => [field.id, field.value]))); }, () => callbacks.current.onReady?.(), (message) => { setError(message); callbacks.current.onFailure?.(message); }); }
    catch { setError("此环境不支持隔离插件。"); callbacks.current.onFailure?.("此环境不支持隔离插件。"); }
    return () => { session.current?.stop(); session.current = null; };
  }, [pkg.sha256, api, active]);
  return <div className="external-plugin-view" aria-label={`插件：${pkg.manifest.name}`}>
    {error ? <p role="alert">{error}</p> : !active ? <p>工具暂停。</p> : !view ? <p role="status">正在启动插件…</p> : <>
      {view.text && <p className="external-plugin-text">{view.text}</p>}
      {view.fields.map((field) => <label key={field.id}>{field.label}{field.multiline ? <Textarea value={values[field.id] ?? ""} maxLength={4000} onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.value }))} /> : <Input value={values[field.id] ?? ""} maxLength={4000} onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.value }))} />}</label>)}
      <div className="reader-tool-actions">{view.actions.map((action) => <Button key={action.id} onClick={() => session.current?.action(action.id, values)}>{action.label}</Button>)}</div>
    </>}
  </div>;
}
export function externalPluginModule(pkg: VerifiedPluginPackage, onFailure: (message: string) => void) {
  const View = ({ api, active }: ReaderToolViewProps) => <PluginView pkg={pkg} api={api} active={active} onFailure={onFailure} />;
  return { manifest: pkg.manifest, command: { id: `open-${pkg.manifest.id}`, title: pkg.manifest.name }, selectionAction: { title: pkg.manifest.name }, Overlay: View, Panel: View };
}
