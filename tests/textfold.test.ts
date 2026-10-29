import assert from "node:assert/strict";
import { test } from "node:test";
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
