import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeReadingMargin } from "../src/reading-preferences";

test("reading margin stays finite and inside 0–50 percent", () => {
  assert.deepEqual([-1, 0, 12.7, 50, 100, NaN, Infinity].map(normalizeReadingMargin), [0, 0, 13, 50, 50, 20, 20]);
});
