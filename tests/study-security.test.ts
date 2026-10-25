import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { jsonContainsSecret } from "../shared/llm-stream.js";
import { parseStudyAnswer, prepareQuestion } from "../shared/study-analysis.js";
import { studyAdapter } from "../shared/study-adapter.js";
import { STUDY_SCHEMA } from "../shared/study-store.js";
import { READING_DATA_SCHEMA } from "../shared/reading-data.js";
import type { QuestionCitation, StudyAdapter } from "../shared/study-types.js";

const citation: QuestionCitation = { id: "doc:1", documentId: "doc", documentRevision: 3, title: "Source",
  anchor: { quote: "The source evidence.", prefix: "", suffix: "", source: "editor" } };

test("question credential protection decodes JSON Unicode escapes and fenced JSON", () => {
  const secret = "sk-review-fixture";
  const output = JSON.stringify({ answer: `The answer is ${secret} [doc:1]`, citations: ["doc:1"], refused: false }).replace(secret, "\\u0073" + secret.slice(1));
  assert.equal(output.includes(secret), false);
  assert.equal(jsonContainsSecret(output, secret), true);
  assert.equal(jsonContainsSecret("```json\n" + output + "\n```", secret), true);
  assert.equal(jsonContainsSecret('{"\\u0073k-review-fixture":"hidden in key"}', secret), true);
  assert.equal(jsonContainsSecret(JSON.stringify({ result: [{ answer: secret }] }), secret), true);
  assert.equal(jsonContainsSecret(JSON.stringify({ answer: "No credentials here [doc:1]", citations: ["doc:1"] }), secret), false);
  assert.equal(jsonContainsSecret("not JSON and no credential", secret), false);
  assert.equal(jsonContainsSecret(output, ""), false);
});

test("question answers reject foreign or unused citations and normalize explicit refusals", () => {
  const valid = parseStudyAnswer('{"answer":"Source-backed statement [doc:1]","citations":["doc:1"],"refused":false}', [citation]);
  assert.deepEqual(valid.citations, [citation]); assert.equal(valid.refused, false);
  assert.throws(() => parseStudyAnswer('{"answer":"Unsupported [other:1]","citations":["other:1"],"refused":false}', [citation]), /当前证据/u);
  assert.throws(() => parseStudyAnswer('{"answer":"Statement with no inline citation","citations":["doc:1"],"refused":false}', [citation]), /正文与引用/u);
  assert.throws(() => parseStudyAnswer('{"answer":"Bad inline reference [other:1]","citations":["doc:1"],"refused":false}', [citation]));
  assert.throws(() => parseStudyAnswer('{"answer":"Uncited statement","citations":[],"refused":false}', [citation]), /缺少引用/u);
  assert.deepEqual(parseStudyAnswer('{"answer":"Untrusted refusal text","citations":[],"refused":true}', []), { answer: "现有证据不足，无法回答。", citations: [], refused: true });
  assert.throws(() => parseStudyAnswer("not a JSON answer", [citation]), /可核实/u);
});

function fixture(documentsTable: StudyAdapter["documentsTable"]) {
  const sql = new DatabaseSync(":memory:"), prefix = documentsTable === "documents" ? "" : "cloud_";
  sql.exec("PRAGMA foreign_keys=ON");
  sql.exec(`CREATE TABLE ${documentsTable}(id TEXT PRIMARY KEY,title TEXT NOT NULL,kind TEXT NOT NULL,source_url TEXT NOT NULL,markdown TEXT NOT NULL,${prefix ? "" : "markdown_edited INTEGER NOT NULL DEFAULT 0,"}folder_id TEXT,deleted_at TEXT,status TEXT NOT NULL DEFAULT 'ready',revision INTEGER NOT NULL DEFAULT 3,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE ${prefix}papers(id TEXT PRIMARY KEY REFERENCES ${documentsTable}(id) ON DELETE CASCADE,status TEXT NOT NULL,extraction_id TEXT NOT NULL);
    CREATE TABLE ${prefix}paper_pages(paper_id TEXT NOT NULL REFERENCES ${prefix}papers(id) ON DELETE CASCADE,extraction_id TEXT NOT NULL,page_number INTEGER NOT NULL,original_json TEXT NOT NULL,PRIMARY KEY(paper_id,extraction_id,page_number));
    CREATE TABLE tags(id INTEGER PRIMARY KEY,name TEXT NOT NULL);
    CREATE TABLE document_tags(document_id TEXT NOT NULL,tag_id INTEGER NOT NULL);`);
  sql.exec((READING_DATA_SCHEMA + STUDY_SCHEMA).replaceAll("REFERENCES documents(", `REFERENCES ${documentsTable}(`));
  const stamp = "2026-10-26T00:00:00.000Z";
  sql.prepare("INSERT INTO study_topics(id,name,note,revision,created_at,updated_at) VALUES ('topic','Evidence','','1',?,?)").run(stamp, stamp);
  const add = (id: string, body: string, paper = false) => {
    sql.prepare(`INSERT INTO ${documentsTable}(id,title,kind,source_url,markdown,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
      .run(id, `Document ${id}`, paper ? "paper" : "article", `https://example.com/${id}`, paper ? "" : body, stamp, stamp);
    sql.prepare("INSERT INTO study_topic_documents(topic_id,document_id) VALUES ('topic',?)").run(id);
    if (paper) {
      sql.prepare(`INSERT INTO ${prefix}papers VALUES (?,'ready',?)`).run(id, `extraction-${id}`);
      sql.prepare(`INSERT INTO ${prefix}paper_pages VALUES (?,?,1,?)`).run(id, `extraction-${id}`, JSON.stringify([{ id: "block-1", type: "paragraph", original: body }]));
    }
  };
  const adapter = studyAdapter({ documentsTable,
    async all(query, values) { return sql.prepare(query).all(...values as never[]); },
    async run(query, values) { return Number(sql.prepare(query).run(...values as never[]).changes); },
    async batch(statements) {
      sql.exec("BEGIN IMMEDIATE");
      try { for (const statement of statements) sql.prepare(statement.sql).all(...statement.values as never[]); sql.exec("COMMIT"); }
      catch (cause) { sql.exec("ROLLBACK"); throw cause; }
    },
  });
  const scope = () => sql.prepare(`SELECT id,revision FROM ${documentsTable} WHERE deleted_at IS NULL ORDER BY id`).all();
  return { sql, add, adapter, scope };
}

for (const table of ["documents", "cloud_documents"] as const) {
  test(`prepared question rejects changed or trashed topic membership even when topic revision stays unchanged (${table})`, async () => {
    const f = fixture(table);
    try {
      f.add("source-a", "Nebularity evidence is present in this paragraph.");
      f.add("source-b", "Another unrelated document.");
      const scope = f.scope(), prepared = await prepareQuestion(f.adapter, "topic", "What does the nebularity evidence say?", 1, scope);
      assert.equal(prepared.evidence[0]?.documentId, "source-a");
      await prepared.verify();
      // Trash an unrelated member: validating only returned citation IDs would miss this change.
      f.sql.prepare(`UPDATE ${table} SET deleted_at=? WHERE id='source-b'`).run("2026-10-26T01:00:00.000Z");
      await assert.rejects(prepared.verify(), /REVISION_CONFLICT/u);
      await assert.rejects(prepareQuestion(f.adapter, "topic", "nebularity evidence", 1, scope), /REVISION_CONFLICT/u);
      f.sql.exec(`UPDATE ${table} SET deleted_at=NULL WHERE id='source-b'; DELETE FROM study_topic_documents WHERE document_id='source-b';`);
      f.add("source-c", "Restored replacement member.");
      await assert.rejects(prepared.verify(), /REVISION_CONFLICT/u);
      await assert.rejects(prepareQuestion(f.adapter, "topic", "nebularity evidence", 1, scope), /REVISION_CONFLICT/u);
    } finally { f.sql.close(); }
  });

  test(`topic retrieval includes relevant paper after twenty earlier IDs and article keywords at the end (${table})`, async () => {
    const papers = fixture(table), articles = fixture(table);
    try {
      for (let index = 1; index <= 21; index += 1) papers.add(`paper-${String(index).padStart(3, "0")}`, index === 21 ? "The quantum evidence appears only in the last ordered paper." : "General material with no matching subject.", true);
      const preparedPaper = await prepareQuestion(papers.adapter, "topic", "What does the quantum evidence say?", 1, papers.scope());
      assert.ok(preparedPaper.evidence.some((entry) => entry.documentId === "paper-021" && entry.anchor.quote.includes("quantum evidence") && entry.anchor.pageNumber === 1));
      await preparedPaper.verify();
      for (let index = 1; index <= 20; index += 1) articles.add(`article-${String(index).padStart(3, "0")}`, "General material with no matching subject.");
      articles.add("article-021", "General background. ".repeat(1500) + "\n\nThe nebularity result is confirmed in this final paragraph.");
      const preparedArticle = await prepareQuestion(articles.adapter, "topic", "What is the nebularity result?", 1, articles.scope());
      assert.ok(preparedArticle.evidence.some((entry) => entry.documentId === "article-021" && entry.anchor.quote.includes("nebularity result")));
      assert.ok(preparedArticle.payload.length < 20_000);
      await preparedArticle.verify();
    } finally { papers.sql.close(); articles.sql.close(); }
  });
}
