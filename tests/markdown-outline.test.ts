import assert from "node:assert/strict";
import test from "node:test";
import { markdownOutline } from "../src/markdown-outline.js";

test("Markdown outline uses real headings, source offsets and skipped-level ancestry", () => {
  const markdown = "# Root **bold**\n\n```md\n# not a heading\n```\n\n#### Child `code`\n\nSame title\n----------\n\n## Same title\n\n> ### Quoted\n";
  const headings = markdownOutline(markdown);
  assert.deepEqual(headings.map(({ title, depth }) => [title, depth]), [["Root bold", 1], ["Child code", 4], ["Same title", 2], ["Same title", 2], ["Quoted", 3]]);
  assert.deepEqual(headings[1].ancestors, [0]);
  assert.deepEqual(headings[4].ancestors, [0, markdown.indexOf("## Same title")]);
  assert.equal(headings[2].offset, markdown.indexOf("Same title"));
  assert.deepEqual(markdownOutline("plain text\n\n    # code"), []);
  assert.deepEqual(markdownOutline("$$\n# fake math heading\n$$\n\n# Real").map(({ title }) => title), ["Real"]);
});
