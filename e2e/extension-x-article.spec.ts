import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const statusId = "2101709924828934222";
const articleId = "2101601158846447616";
const title = "Jev Engineering: How to Stop Paying a Frontier Model to Make Yes-or-No Decisions (full course)";

// The logged-in reader uses the selectors supported by Defuddle's existing
// XArticleExtractor, rather than the public .x-article-body layout.
function reader(id: string, empty = false, readView = true) {
  return `<article data-testid="tweet"><a href="/hanakoxbt/status/${id}"><time datetime="2026-09-21T00:27:00Z">Sep 21</time></a>
    <div ${readView ? 'data-testid="twitterArticleReadView"' : ""}>
      <div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/cover.jpg?format=jpg&amp;name=medium" alt="Article cover image"></div>
      <div data-testid="twitter-article-title">${id === statusId ? title : "RECOMMENDED_ARTICLE"}</div>
      <div data-testid="twitterArticleRichTextView"><div class="public-DraftEditor-content" contenteditable="false">
        ${empty ? "" : `<div data-block="true" class="longform-unstyled"><div class="public-DraftStyleDefault-block"><span data-text="true">${id === statusId ? "Open the trace of any agent you have shipped and count the calls." : "RECOMMENDED_TEXT"}</span></div></div>
        <h2 data-testid="longform-header"><span>01. Split - find the decisions, not the text</span></h2>
        <h1>ARTICLE_SECTION_HEADING</h1>
        <div class="longform-unstyled"><span>The answer space is known before you ask. Read the <a href="https://example.com/source">original source</a>.</span></div>
        <div data-testid="markdown-code-block" contenteditable="false"><span>python</span><button>Copy code</button><pre><code class="language-python">if confidence &gt;= 0.88:\n    decision = "ship"</code></pre></div>
        <ul><li>collect real examples</li><li>pin the model version</li></ul>
        <div data-block="true"><div data-testid="tweetPhoto"><a href="/hanakoxbt/article/${id === statusId ? articleId : id}/media/1"><img src="https://pbs.twimg.com/media/inside.jpg?format=jpg&amp;name=medium" alt="Diagram"></a></div></div>
        <div contenteditable="true">EDITABLE_SECRET</div><form><p>FORM_SECRET</p></form>
        <div class="longform-unstyled"><span>Start with one decision. Give it the minimum state.</span></div>`}
      </div></div>
      <button>Summarize with Grok</button>
    </div>
  </article>`;
}

test("extension clips the X native read view without losing read-only rich text", async ({ page, browserName }) => {
  const script = await readFile(`dist/extensions/zhiye-clipper-${browserName === "firefox" ? "firefox" : "chrome"}/content.js`, "utf8");
  await page.route("https://x.com/**", (route) => route.fulfill({
    contentType: "text/html; charset=utf-8",
    body: `<!doctype html><html><head><title>Hanako on X</title></head><body><main data-testid="primaryColumn">
      <aside>${reader("999")}</aside>
      ${reader(statusId, false, !route.request().url().includes("body-only"))
        .replace('<article data-testid="tweet">', route.request().url().includes("schema")
          ? `<article data-testid="tweet" itemtype="https://schema.org/Article" itemid="https://x.com/hanakoxbt/article/${statusId}">` : '<article data-testid="tweet">')
        .replace('alt="Article cover image"', route.request().url().includes("schema") ? 'itemprop="image" alt="Article cover image"' : 'alt="Article cover image"')}
      <article data-testid="tweet"><p>REPLY_OUTSIDE_ARTICLE</p></article>
    </main></body></html>`,
  }));
  await page.route("https://pbs.twimg.com/**", (route) => route.abort());
  for (const path of [`/hanakoxbt/status/${statusId}`, `/hanakoxbt/article/${articleId}`, `/hanakoxbt/status/${statusId}?body-only`, `/hanakoxbt/article/${articleId}?body-only`, `/hanakoxbt/status/${statusId}?schema`]) {
    await page.goto(`https://x.com${path}`);
    await page.addScriptTag({ content: script });
    const result = await page.evaluate(async () => await (window as typeof window & {
      __ZHIYE_CLIP_RESULT__: Promise<{ title: string; markdown: string }>;
    }).__ZHIYE_CLIP_RESULT__);
    expect(result.title).toBe(title);
    expect(result.markdown).toContain("Open the trace");
    expect(result.markdown).toMatch(/## 01\\?\. Split/u);
    expect(result.markdown).toContain("[original source](https://example.com/source)");
    expect(result.markdown).toMatch(/```python\nif confidence >= 0\.88:\n {4}decision = "ship"/u);
    expect(result.markdown).toContain("pin the model version");
    expect(result.markdown).toContain("Start with one decision");
    expect(result.markdown).toContain("https://pbs.twimg.com/media/cover.jpg");
    expect(result.markdown.split("https://pbs.twimg.com/media/cover.jpg")).toHaveLength(2);
    expect(result.markdown).toContain("https://pbs.twimg.com/media/inside.jpg");
    expect(result.markdown.split("Open the trace")).toHaveLength(2);
    expect(result.markdown).not.toMatch(/RECOMMENDED_TEXT|REPLY_OUTSIDE_ARTICLE|EDITABLE_SECRET|FORM_SECRET|Copy code|Summarize with Grok/u);
  }
});

test("extension clips a standalone X native reader and rejects an unrelated post reader", async ({ page, browserName }) => {
  await page.route("https://x.com/**", (route) => route.fulfill({
    contentType: "text/html; charset=utf-8",
    body: `<!doctype html><html><body><main data-testid="primaryColumn">${route.request().url().includes("unrelated")
      ? reader("999")
      : reader(statusId, false, !route.request().url().includes("body-only")).replace(/<article data-testid="tweet"><a[^>]+><time[^>]+>[^<]+<\/time><\/a>/u, "").replace(/<\/article>$/u, "")}</main></body></html>`,
  }));
  await page.route("https://pbs.twimg.com/**", (route) => route.abort());
  const script = await readFile(`dist/extensions/zhiye-clipper-${browserName === "firefox" ? "firefox" : "chrome"}/content.js`, "utf8");
  for (const suffix of ["", "?body-only"]) {
    await page.goto(`https://x.com/hanakoxbt/status/${statusId}${suffix}`);
    await page.addScriptTag({ content: script });
    const result = await page.evaluate(async () => await (window as typeof window & {
      __ZHIYE_CLIP_RESULT__: Promise<{ title: string; markdown: string }>;
    }).__ZHIYE_CLIP_RESULT__);
    expect(result.title).toBe(title);
    expect(result.markdown).toContain("Open the trace");
    expect(result.markdown).toContain("Start with one decision");
    expect(result.markdown).toContain("https://pbs.twimg.com/media/cover.jpg");
  }
  await page.goto(`https://x.com/hanakoxbt/status/${statusId}?unrelated`);
  await page.addScriptTag({ content: script });
  const error = await page.evaluate(async () => (window as typeof window & {
    __ZHIYE_CLIP_RESULT__: Promise<unknown>;
  }).__ZHIYE_CLIP_RESULT__.catch((reason: Error) => reason.message));
  expect(error).toContain("正文尚未加载");
});

test("extension rejects a native X cover with no rendered article body", async ({ page, browserName }) => {
  await page.route("https://x.com/**", (route) => route.fulfill({
    contentType: "text/html; charset=utf-8",
    body: `<!doctype html><html><body><main data-testid="primaryColumn">${reader(statusId, true)
      .replace('<div class="public-DraftEditor-content" contenteditable="false">', '<div class="public-DraftEditor-content" contenteditable="false"><form><p>FORM_ONLY</p></form><button><p>CONTROL_ONLY</p></button>')}</main></body></html>`,
  }));
  await page.route("https://pbs.twimg.com/**", (route) => route.abort());
  await page.goto(`https://x.com/hanakoxbt/status/${statusId}`);
  await page.addScriptTag({ content: await readFile(`dist/extensions/zhiye-clipper-${browserName === "firefox" ? "firefox" : "chrome"}/content.js`, "utf8") });
  const error = await page.evaluate(async () => (window as typeof window & {
    __ZHIYE_CLIP_RESULT__: Promise<unknown>;
  }).__ZHIYE_CLIP_RESULT__.catch((reason: Error) => reason.message));
  expect(error).toContain("正文尚未加载");
});
