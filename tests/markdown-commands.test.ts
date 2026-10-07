import assert from "node:assert/strict";
import { test } from "node:test";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import { history, undo, redo } from "@codemirror/commands";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { EditorView } from "@codemirror/view";
import { inlineFormat, blockFormat, insertFormat } from "../src/markdown-commands";

function editor(doc: string, from = 0, to = doc.length, readOnly = false) {
  let state = EditorState.create({ doc, selection: { anchor: from, head: to }, extensions: [history(), EditorState.readOnly.of(readOnly)] });
  return { get state() { return state; }, dispatch(...spec: TransactionSpec[]) { state = state.update(...spec).state; }, focus() {} } as unknown as EditorView;
}

test("format transactions preserve selection, whitespace, undo/redo and readonly text", () => {
  const view = editor("中文 text ");
  assert.equal(inlineFormat("bold")(view), true);
  assert.equal(view.state.doc.toString(), "**中文 text** ");
  assert.equal(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to), "中文 text");
  inlineFormat("bold")(view);
  assert.equal(view.state.doc.toString(), "中文 text ");
  undo(view); assert.equal(view.state.doc.toString(), "**中文 text** ");
  redo(view); assert.equal(view.state.doc.toString(), "中文 text ");
  const locked = editor("保留文字", 0, 4, true);
  for (const command of [inlineFormat("bold"), blockFormat("h2"), insertFormat("table")]) assert.equal(command(locked), false);
  assert.equal(locked.state.doc.toString(), "保留文字");
});

test("block formatting excludes a next line selected only at its boundary and toggles lists", () => {
  const view = editor("first\nsecond\nthird", 0, 6);
  blockFormat("h2")(view);
  assert.equal(view.state.doc.toString(), "## first\nsecond\nthird");
  const list = editor("first\nsecond");
  blockFormat("ordered")(list); assert.equal(list.state.doc.toString(), "1. first\n2. second");
  blockFormat("task")(list); assert.equal(list.state.doc.toString(), "- [ ] first\n- [ ] second");
  blockFormat("task")(list); assert.equal(list.state.doc.toString(), "first\nsecond");
  for (const status of [" ", "x", "X"]) {
    const task = editor(`- [${status}] item`); blockFormat("bullet")(task);
    assert.equal(task.state.doc.toString(), "- item");
  }
  for (const source of ["## item", "> item", "- item", "1. item", "- [x] item"]) {
    const paragraph = editor(source); blockFormat("paragraph")(paragraph);
    assert.equal(paragraph.state.doc.toString(), "item");
  }
  const mixed = editor("- [x] done\npending"); blockFormat("task")(mixed);
  assert.equal(mixed.state.doc.toString(), "- [x] done\n- [ ] pending");
});

test("insertions retain prose, isolate block syntax and protect backtick content", () => {
  const table = editor("段落"); insertFormat("table")(table);
  assert.ok(table.state.doc.toString().startsWith("段落\n\n| 标题 |"));
  const code = editor("```js\nx\n```"); insertFormat("codeblock")(code);
  assert.ok(code.state.doc.toString().startsWith("````\n```js"));
  const manyRuns = editor("`x".repeat(150_000)); insertFormat("codeblock")(manyRuns);
  assert.ok(manyRuns.state.doc.toString().startsWith("```\n`x"));
  const inline = editor("`x`"); inlineFormat("code")(inline);
  assert.equal(inline.state.doc.toString(), "`` `x` ``");
  inlineFormat("code")(inline); assert.equal(inline.state.doc.toString(), "`x`");
  const emphasis = editor("**文字**", 2, 4);
  inlineFormat("italic")(emphasis); assert.equal(emphasis.state.doc.toString(), "***文字***");
  inlineFormat("italic")(emphasis); assert.equal(emphasis.state.doc.toString(), "**文字**");
  const selectedSyntax = editor("**文字**"); inlineFormat("bold")(selectedSyntax);
  assert.equal(selectedSyntax.state.doc.toString(), "文字");
  const link = editor("织页"); inlineFormat("link")(link);
  assert.equal(link.state.doc.toString(), "[织页](https://)");
  assert.equal(link.state.sliceDoc(link.state.selection.main.from, link.state.selection.main.to), "https://");
  for (const [source, visible] of [["说明[草稿", "说明[草稿"], ["说明\\[草稿", "说明[草稿"], ["说明\\", "说明\\"]]) {
    const bracketLink = editor(source); inlineFormat("link")(bracketLink);
    const paragraph = fromMarkdown(bracketLink.state.doc.toString()).children[0];
    assert.ok(paragraph.type === "paragraph");
    const result = paragraph.children[0]; assert.ok(result.type === "link");
    assert.equal(result.children.map((node) => node.type === "text" ? node.value : "").join(""), visible);
    assert.equal(bracketLink.state.sliceDoc(bracketLink.state.selection.main.from, bracketLink.state.selection.main.to), "https://");
  }
  const math = editor("beforeafter", 6, 6); insertFormat("math")(math);
  assert.equal(math.state.doc.toString(), "before\n\n$$\nE = mc^2\n$$\n\nafter");
});
