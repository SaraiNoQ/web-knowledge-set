import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeReadingMargin } from "../src/reading-preferences";

test("reading margin stays finite and inside 0–50 percent", () => {
  assert.deepEqual([-1, 0, 12.7, 50, 100, NaN, Infinity].map(normalizeReadingMargin), [0, 0, 13, 50, 50, 20, 20]);
});

import { normalizeReadingText } from "../src/reading-preferences";
test("reading typography rejects unknown fonts and clamps finite settings", () => {
  assert.deepEqual(normalizeReadingText({ font: "url(unsafe)", fontSize: 90, lineHeight: NaN, letterSpacing: -1 }), { font: "serif", fontSize: 28, lineHeight: 1.95, letterSpacing: 0 });
  assert.deepEqual(normalizeReadingText(null), { font: "serif", fontSize: 16, lineHeight: 1.95, letterSpacing: 0 });
});
