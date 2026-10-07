import { EditorSelection, type EditorState } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import type { Command } from "@codemirror/view";

export const INLINE_FORMATS = [
  { id: "bold", label: "加粗", key: "Mod-b", marker: "**", icon: "M6 4h7a4 4 0 0 1 0 8H6zm0 8h8a4 4 0 0 1 0 8H6z" },
  { id: "italic", label: "斜体", key: "Mod-i", marker: "*", icon: "M10 4h10M4 20h10M15 4 9 20" },
  { id: "strike", label: "删除线", key: "Mod-Shift-x", marker: "~~", icon: "M17 6c-2-3-10-3-10 2 0 2 2 3 5 4m-5 6c2 3 10 3 10-2M3 12h18" },
  { id: "code", label: "行内代码", key: "Mod-`", marker: "`", icon: "m8 7-5 5 5 5m8-10 5 5-5 5M14 4l-4 16" },
  { id: "link", label: "链接", key: "Mod-k", marker: "", icon: "m10 13 4-4m-6 5-2 2a3 3 0 0 1-4-4l4-4a3 3 0 0 1 4 0m4 2 2-2a3 3 0 0 0-4-4l-4 4a3 3 0 0 0 0 4" },
] as const;
export type InlineFormat = typeof INLINE_FORMATS[number]["id"];
export type BlockFormat = "paragraph" | "h1" | "h2" | "h3" | "quote" | "bullet" | "ordered" | "task";
export type InsertFormat = "codeblock" | "table" | "math" | "divider";
const backtickFence = (text: string, minimum = 0) => "`".repeat((text.match(/`+/g) || []).reduce((longest, run) => Math.max(longest, run.length), minimum) + 1);

export function inlineFormatActive(state: EditorState, id: InlineFormat) {
  const marker = INLINE_FORMATS.find((item) => item.id === id)!.marker;
  const { from, to, empty } = state.selection.main;
  if (!marker || empty) return false;
  if (id === "italic" && ((state.sliceDoc(Math.max(0, from - 2), from) === "**" && state.sliceDoc(Math.max(0, from - 3), from) !== "***") || (state.sliceDoc(to, to + 2) === "**" && state.sliceDoc(to, to + 3) !== "***"))) return false;
  if (id === "code" && state.sliceDoc(Math.max(0, from - 2), from) === "` " && state.sliceDoc(to, to + 2) === " `") return true;
  return from >= marker.length && state.sliceDoc(from - marker.length, from) === marker && state.sliceDoc(to, to + marker.length) === marker;
}

export function inlineFormat(id: InlineFormat): Command {
  return (view) => {
    if (view.state.readOnly) return false;
    const { state } = view;
    view.dispatch(state.changeByRange((range) => {
      const text = state.sliceDoc(range.from, range.to);
      if (text && !text.trim()) return { range };
      if (id === "link") {
        const label = (text || "链接文字").replace(/\\[\s\S]|[\[\]]|\\$/g, (token) => token.length === 1 ? "\\" + token : token);
        const insert = `[${label}](https://)`;
        const start = range.from + label.length + 3;
        return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.range(start, start + 8) };
      }
      let marker: string = INLINE_FORMATS.find((item) => item.id === id)!.marker;
      if (id === "code") {
        marker = backtickFence(text);
      }
      const codePadding = id === "code" && /^`|`$/.test(text) ? " " : "";
      const edge = marker.length + codePadding.length;
      const wrapped = !range.empty && range.from >= edge && state.sliceDoc(range.from - edge, range.from) === marker + codePadding && state.sliceDoc(range.to, range.to + edge) === codePadding + marker && inlineFormatActive(state, id);
      if (wrapped) return { changes: [{ from: range.from - edge, to: range.from }, { from: range.to, to: range.to + edge }], range: EditorSelection.range(range.from - edge, range.to - edge) };
      if (id !== "code" && text.length > marker.length * 2 && text.startsWith(marker) && text.endsWith(marker) && !(id === "italic" && text.startsWith("**") && !text.startsWith("***"))) {
        const content = text.slice(marker.length, -marker.length);
        return { changes: { from: range.from, to: range.to, insert: content }, range: EditorSelection.range(range.from, range.from + content.length) };
      }
      const leading = text.match(/^\s*/)?.[0] || "";
      const trailing = text.match(/\s*$/)?.[0] || "";
      const content = text.trim() || "文字";
      const padding = id === "code" && /^`|`$/.test(content) ? " " : "";
      const prefix = marker + padding;
      return { changes: { from: range.from, to: range.to, insert: leading + prefix + content + padding + marker + trailing }, range: EditorSelection.range(range.from + leading.length + prefix.length, range.from + leading.length + prefix.length + content.length) };
    }), { userEvent: "input.format", annotations: isolateHistory.of("full"), scrollIntoView: true });
    view.focus();
    return true;
  };
}

export function blockFormat(id: BlockFormat): Command {
  return (view) => {
    const { state } = view;
    if (state.readOnly) return false;
    const { from, to } = state.selection.main;
    const first = state.doc.lineAt(from);
    const last = state.doc.lineAt(to > from && state.doc.lineAt(to).from === to ? to - 1 : to);
    const lines = state.sliceDoc(first.from, last.to).split("\n");
    const prefix = id === "quote" ? "> " : id === "bullet" ? "- " : id === "task" ? "- [ ] " : id.startsWith("h") ? "#".repeat(Number(id[1])) + " " : "";
    const taskMarker = /^[-+*] (\[[ xX]\]) /;
    const pattern = id === "paragraph" ? /^(?:#{1,6} |> ?|[-+*] (?:\[[ xX]\] )?|\d+[.)] )/ : id === "quote" ? /^> ?/ : id === "bullet" || id === "task" || id === "ordered" ? /^(?:[-+*] (?:\[[ xX]\] )?|\d+[.)] )/ : /^#{1,6} /;
    const already = id !== "paragraph" && lines.every((line, index) => id === "task" ? taskMarker.test(line) : line.startsWith(id === "ordered" ? `${index + 1}. ` : prefix) && !(id === "bullet" && taskMarker.test(line)));
    const insert = lines.map((line, index) => {
      const marker = id === "task" ? taskMarker.exec(line)?.[1] : undefined;
      const nextPrefix = id === "ordered" ? `${index + 1}. ` : marker ? `- ${marker} ` : prefix;
      return (already || id === "paragraph" ? "" : nextPrefix) + line.replace(pattern, "");
    }).join("\n");
    view.dispatch({ changes: { from: first.from, to: last.to, insert }, selection: { anchor: first.from, head: first.from + insert.length }, userEvent: "input.format", annotations: isolateHistory.of("full"), scrollIntoView: true });
    view.focus();
    return true;
  };
}

export function insertFormat(id: InsertFormat): Command {
  return (view) => {
    const { state } = view;
    if (state.readOnly) return false;
    const { from, to } = state.selection.main;
    const text = state.sliceDoc(from, to);
    let body: string;
    let start = 0;
    let length = 0;
    if (id === "codeblock") {
      const fence = backtickFence(text, 2);
      const content = text || "在这里输入代码";
      body = `${fence}\n${content}\n${fence}`; start = fence.length + 1; length = content.length;
    } else if (id === "math") {
      const content = text || "E = mc^2";
      body = `$$\n${content}\n$$`; start = 3; length = content.length;
    } else if (id === "table") {
      // Keep selected prose intact; the template is inserted after it.
      body = `${text ? text + "\n\n" : ""}| 标题 | 内容 |\n| --- | --- |\n| 项目 | 说明 |`;
      start = (text ? text.length + 2 : 0) + 2; length = 2;
    } else {
      body = `${text ? text + "\n\n" : ""}---`; start = body.length;
    }
    const before = from > 0 ? (state.sliceDoc(Math.max(0, from - 2), from).endsWith("\n\n") ? "" : state.sliceDoc(from - 1, from) === "\n" ? "\n" : "\n\n") : "";
    const after = to < state.doc.length ? (state.sliceDoc(to, to + 2).startsWith("\n\n") ? "" : state.sliceDoc(to, to + 1) === "\n" ? "\n" : "\n\n") : "\n\n";
    view.dispatch({ changes: { from, to, insert: before + body + after }, selection: { anchor: from + before.length + start, head: from + before.length + start + length }, userEvent: "input.format", annotations: isolateHistory.of("full"), scrollIntoView: true });
    view.focus();
    return true;
  };
}
