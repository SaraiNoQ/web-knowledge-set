import { pluginObject } from "./plugin-package";

export interface PluginView {
  text: string;
  fields: Array<{ id: string; label: string; value: string; multiline: boolean }>;
  actions: Array<{ id: string; label: string }>;
}
const text = (value: unknown, max: number) => {
  if (typeof value !== "string" || value.length > max) throw new Error("插件界面内容无效或过长。");
  return value;
};
const id = (value: unknown) => { const key = text(value, 40); if (!/^[a-z][a-z0-9-]*$/u.test(key)) throw new Error("插件控件名称无效。"); return key; };
export function parsePluginView(value: unknown): PluginView {
  const view = pluginObject(value, ["text", "fields", "actions"]);
  if (!Array.isArray(view.fields) || view.fields.length > 4 || !Array.isArray(view.actions) || view.actions.length > 4) throw new Error("插件界面最多包含 4 个输入和 4 个操作。");
  const fields = view.fields.map((raw) => { const field = pluginObject(raw, ["id", "label", "value", "multiline"]); if (field.multiline !== undefined && typeof field.multiline !== "boolean") throw new Error("插件输入格式无效。"); return { id: id(field.id), label: text(field.label, 80), value: text(field.value, 4000), multiline: field.multiline === true }; });
  const actions = view.actions.map((raw) => { const action = pluginObject(raw, ["id", "label"]); return { id: id(action.id), label: text(action.label, 80) }; });
  if (new Set(fields.map((field) => field.id)).size !== fields.length || new Set(actions.map((action) => action.id)).size !== actions.length || [...fields, ...actions].some((item) => !item.label.trim())) throw new Error("插件控件缺少名称或存在重复。");
  return { text: text(view.text, 40000), fields, actions };
}
export function parsePluginRequest(value: unknown) {
  const request = pluginObject(value, ["type", "id", "method", "args"]);
  if (request.type !== "request" || typeof request.id !== "string" || !/^[0-9]{1,9}$/u.test(request.id) || typeof request.method !== "string" || request.method.length > 40) throw new Error("插件请求格式无效。");
  if (!request.args || typeof request.args !== "object" || Array.isArray(request.args)) throw new Error("插件参数无效。");
  return { id: request.id, method: request.method, args: request.args as Record<string, unknown> };
}
export function pluginMessageBytes(value: unknown) {
  const encoded = JSON.stringify(value);
  if (!encoded || encoded.length > 64000 || new TextEncoder().encode(encoded).byteLength > 64 * 1024) throw new Error("插件消息超过 64 KiB。");
}
