import assert from "node:assert/strict";
import test from "node:test";
import { parsePluginRequest, parsePluginView, pluginMessageBytes } from "../src/reader-tools/plugin-protocol.js";

test("plugin UI accepts bounded text controls and rejects HTML, URLs, unknown keys and duplicate IDs", () => {
  const value = { text: "<script>plain text</script>", fields: [{ id: "note", label: "笔记", value: "", multiline: true }], actions: [{ id: "save", label: "保存" }] };
  assert.equal(parsePluginView(value).text, value.text);
  for (const invalid of [{ ...value, html: "<img>" }, { ...value, url: "https://attacker.example" }, { ...value, fields: [...value.fields, ...value.fields] }, { ...value, actions: Array(5).fill(value.actions[0]) }, { ...value, fields: [{ ...value.fields[0], value: "x".repeat(4001) }] }]) assert.throws(() => parsePluginView(invalid));
});
test("plugin RPC validates IDs, argument shape and message bytes before dispatch", () => {
  assert.equal(parsePluginRequest({ type: "request", id: "1", method: "selection.get", args: {} }).method, "selection.get");
  for (const invalid of [{ type: "request", id: "__proto__", method: "selection.get", args: {} }, { type: "request", id: "1", method: "selection.get", args: [] }, { type: "request", id: "1", method: "selection.get", args: {}, extra: true }]) assert.throws(() => parsePluginRequest(invalid));
  assert.throws(() => pluginMessageBytes({ data: "中".repeat(22000) }));
});
