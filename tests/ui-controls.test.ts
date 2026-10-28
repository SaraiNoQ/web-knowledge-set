import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Range } from "../src/components/ui/Controls";

test("shared range derives and clamps progress for every range scale", () => {
  for (const [min, max, value, expected] of [[0.3, 0.9, 0.6, 50], [0, 50, 10, 20], [0, 200, 100, 50], [0, 50, -5, 0], [0, 50, 60, 100], [1, 1, 1, 0]]) {
    const html = renderToStaticMarkup(createElement(Range, { min, max, value }));
    assert.match(html, /class="ui-range"/);
    const progress = Number(html.match(/--range-progress:([\d.]+)%/)?.[1]);
    assert.ok(Math.abs(progress - expected) < 0.0001, html);
  }
});

test("visible app controls use shared components; native internals and file inputs stay native", () => {
  function visit(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (path !== join("src", "components", "ui")) visit(path); continue; }
      if (!path.endsWith(".tsx")) continue;
      const source = readFileSync(path, "utf8");
      assert.doesNotMatch(source, /<(?:select|textarea|button)\b/, path);
      for (const match of source.matchAll(/<input\b([\s\S]*?)\/>/gu)) {
        assert.ok(/type="(?:file|hidden)"/.test(match[1]) || (/type="radio"/.test(match[1]) && /className="ui-checkbox"/.test(match[1])), path);
      }
    }
  }
  visit("src");
});
