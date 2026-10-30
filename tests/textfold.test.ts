import assert from "node:assert/strict";
import { test } from "node:test";
import { fromMarkdown } from "mdast-util-from-markdown";
import { foldPlan, foldOutput, readFold, foldedMarkdown, parseFoldEntries } from "../shared/textfold.js";

const paragraph = "研究发现这种方法可以减少处理时间，但只在测试数据上得到验证。实际部署仍然需要考虑网络延迟和输入数据的差异。因此我们建议先完成小规模测试，再决定是否扩大应用范围。";
const markdown = `# 方法\n\n${paragraph}\n\n\`\`\`js\nconst unchanged = true;\n\`\`\`\n\n![图](asset://image)\n\n$$x^2$$`;
function replies(source: string) {
  return foldPlan(source).batches.map(batch => JSON.stringify(batch.map(unit => ({ id: unit.id, evidence: [0], takeaway: "方法在测试数据上更快。", reason: "部署前仍需验证。", topic: "方法验证" }))));
}
test("folding preserves original sentences, code, images, math and full source", () => {
  const data = readFold(markdown, foldOutput(markdown, replies(markdown)))!;
  assert.ok(data);
  assert.equal(foldedMarkdown(markdown, data, "full"), markdown);
  const brief = foldedMarkdown(markdown, data, "brief");
  assert.ok(brief.includes(foldPlan(markdown).units[0]!.sentences[0]!));
  assert.ok(brief.includes("const unchanged = true;"));
  assert.ok(brief.includes("![图](asset://image)"));
  assert.ok(brief.includes("$$x^2$$"));
  assert.ok(foldedMarkdown(markdown, data, "topic").includes("方法验证"));
});
test("long article covers every eligible paragraph across batches", () => {
  const source = Array.from({length: 100}, (_, i) => `## ${i}\n\n${paragraph}`).join("\n\n");
  const plan = foldPlan(source);
  assert.equal(plan.units.length, 100);
  assert.ok(plan.batches.length > 1);
  assert.equal(readFold(source, foldOutput(source, replies(source)))!.entries.length, 100);
});
test("reject invalid evidence, duplicate IDs, incomplete output and stale source", () => {
  const units = foldPlan(markdown).units;
  const entry = JSON.parse(replies(markdown)[0]!)[0];
  assert.throws(() => parseFoldEntries([{...entry, evidence: [999]}], units));
  assert.throws(() => parseFoldEntries([{...entry, evidence: [0, 0]}], units));
  assert.throws(() => foldOutput(markdown, []));
  assert.equal(readFold("prefix\n\n" + markdown, foldOutput(markdown, replies(markdown))), null);
  const two = foldPlan(`${paragraph}\n\n${paragraph}`).units;
  assert.throws(() => parseFoldEntries([entry, entry], two));
});

test("formatted paragraphs fold by visible sentences and preserve selected inline structure", () => {
  const source = `**${paragraph}**\n\n${paragraph.replace("这种方法", "[这种方法](https://example.com/method)")}`;
  const plan = foldPlan(source);
  assert.equal(plan.units.length, 2);
  assert.ok(plan.units.every(unit => unit.sentences.length === 3 && unit.sentences.join("") === paragraph));
  const data = readFold(source, foldOutput(source, replies(source)))!;
  const brief = foldedMarkdown(source, data, "brief");
  assert.ok(!brief.includes("实际部署"));
  assert.ok(brief.includes(`**${plan.units[0]!.sentences[0]}**`));
  assert.ok(brief.includes("[这种方法](https://example.com/method)"));
  data.entries[0]!.evidence = [0, 2];
  assert.match(foldedMarkdown(source, data, "brief"), /\*\*研究发现.+\*\* \*\*因此我们/u);
});

test("list and quote paragraphs fold while tables, code and math remain unchanged", () => {
  const source = `- ${paragraph}\n  ${paragraph}\n  - ${paragraph}\n\n> ${paragraph}\n> ${paragraph}\n\n| 内容 |\n| --- |\n| ${paragraph} |\n\n${paragraph}![图](asset://image)\n\n${paragraph}\`code\`\n\n${paragraph}$x$`;
  assert.equal(foldPlan(source).units.length, 3);
  const data = readFold(source, foldOutput(source, replies(source)))!;
  const topic = foldedMarkdown(source, data, "topic");
  assert.ok(topic.startsWith("- 方法验证\n  - 方法验证"));
  assert.ok(topic.includes("> 方法验证"));
  assert.ok(topic.includes(`| ${paragraph} |`));
  assert.ok(topic.includes(`${paragraph}![图](asset://image)`));
  assert.ok(topic.includes(`${paragraph}\`code\``));
  assert.ok(topic.includes(`${paragraph}$x$`));
  assert.equal(foldedMarkdown(source, data, "full"), source);
});

test("all five levels give different content and each written level retains its own role", () => {
  const data = readFold(paragraph, foldOutput(paragraph, [JSON.stringify([{ id: "p0", evidence: [0, 1], takeaway: "测试方法提速。", reason: "部署仍需验证。", topic: "测试方法" }])]))!;
  const levels = ["full", "brief", "key", "takeaway", "topic"] as const;
  const output = levels.map(level => foldedMarkdown(paragraph, data, level));
  assert.equal(new Set(output).size, 5);
  for (let index = 1; index < output.length; index++) assert.ok(output[index]!.length < output[index - 1]!.length);
  assert.equal(output[1], foldPlan(paragraph).units[0]!.sentences.slice(0, 2).join(" "));
  assert.equal(output[2], "测试方法提速。 部署仍需验证。");
  assert.equal(output[3], "测试方法提速。");
  assert.equal(output[4], "测试方法");
});

test("accepts a complete JSON code fence but rejects incomplete results and old sentence mappings", () => {
  const outputs = replies(markdown);
  const output = foldOutput(markdown, outputs.map(value => `\n\`\`\`json\n${value}\n\`\`\`\n`));
  assert.ok(readFold(markdown, output));
  assert.equal(readFold(markdown, output.replace("zhiye-fold-v2", "zhiye-fold-v1")), null);
  assert.throws(() => foldOutput(markdown, outputs.map(value => `explanation\n${value}`)));
  assert.throws(() => foldOutput(markdown, outputs.map(value => value.slice(0, -1))));
  const data = readFold(markdown, output)!;
  data.entries[0]!.takeaway = "费用 $5 与 $10，文本 &copy; 保持文字。";
  assert.match(foldedMarkdown(markdown, data, "takeaway"), /\\\$5 与 \\\$10，文本 &amp;copy;/u);
  data.entries[0]!.reason = "";
  assert.ok(readFold(markdown, JSON.stringify(data)));
});


test("sentence slicing keeps autolink destinations and shortened reference labels resolving", () => {
  const autolinks = ["<https://example.com/method>", "https://example.com/method", "<https://example.com/?x=&copy;>"];
  for (const link of autolinks) {
    const source = paragraph.replace("这种方法", ` ${link} `);
    const data = readFold(source, foldOutput(source, replies(source)))!;
    const first = fromMarkdown(foldedMarkdown(source, data, "brief")).children[0];
    assert.equal(first?.type, "paragraph");
    const outputLink = first?.type === "paragraph" && first.children.find(child => child.type === "link");
    assert.equal(outputLink && outputLink.type === "link" ? outputLink.url : null, link.includes("?x=") ? "https://example.com/?x=&copy;" : "https://example.com/method");
  }
  for (const suffix of ["", "[]", "[ref]"]) {
    const source = `[${paragraph}]${suffix}\n\n[${suffix === "[ref]" ? "ref" : paragraph}]: https://example.com/method`;
    const data = readFold(source, foldOutput(source, replies(source)))!;
    const tree = fromMarkdown(foldedMarkdown(source, data, "brief"));
    const first = tree.children[0];
    const reference = first?.type === "paragraph" && first.children.find(child => child.type === "linkReference");
    const definition = tree.children.find(child => child.type === "definition");
    assert.ok(reference && reference.type === "linkReference");
    assert.equal(reference.identifier, definition?.identifier);
  }
});
