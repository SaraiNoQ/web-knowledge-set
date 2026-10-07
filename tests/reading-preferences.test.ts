import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeReadingMargin } from "../src/reading-preferences";

test("reading margin stays finite and inside 0–50 percent", () => {
  assert.deepEqual([-1, 0, 12.7, 50, 100, NaN, Infinity].map(normalizeReadingMargin), [0, 0, 13, 50, 50, 20, 20]);
});

import { normalizeReadingText } from "../src/reading-preferences";
test("reading typography rejects unknown fonts and clamps finite settings", () => {
  assert.deepEqual(normalizeReadingText({ font: "url(unsafe)", fontSize: 90, lineHeight: NaN, letterSpacing: -1 }), { style: "paper", font: "serif", fontSize: 28, lineHeight: 1.95, letterSpacing: 0 });
  assert.deepEqual(normalizeReadingText(null), { style: "paper", font: "serif", fontSize: 16, lineHeight: 1.95, letterSpacing: 0 });
});

import { applyReadingStyle, DEFAULT_READING_TEXT } from "../src/reading-preferences";
test("reading styles migrate old preferences and retain custom size, spacing, and safe values", () => {
  assert.equal(normalizeReadingText({ style: "__proto__" }).style, "paper");
  assert.equal(normalizeReadingText({ style: "technical" }).style, "technical");
  assert.deepEqual(applyReadingStyle({ ...DEFAULT_READING_TEXT, fontSize: 22, letterSpacing: .08 }, "technical"), { style: "technical", font: "sans", fontSize: 22, lineHeight: 1.7, letterSpacing: .08 });
});
