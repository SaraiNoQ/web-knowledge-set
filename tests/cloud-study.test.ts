import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { handleRequest, type CloudEnv } from "../cloud/worker.js";
import type { D1Database, D1Result, D1Statement } from "../cloud/extension.js";
import type { StudyTopicDetail } from "../shared/study-types.js";

class Statement implements D1Statement {
  constructor(private owner: Database, readonly query: string, private values: unknown[] = []) {}
  bind(...values: unknown[]) { return new Statement(this.owner, this.query, values); }
  async first<T>() {
    const row = this.owner.sqlite.prepare(this.query).get(...this.values as never[]) ?? null;
    if (/key\s*=\s*'data_epoch'/u.test(this.query) && this.owner.nextEpochRead) { const callback = this.owner.nextEpochRead; this.owner.nextEpochRead = undefined; callback(); }
    return row as T | null;
  }
  async all<T>() { return { results: this.owner.sqlite.prepare(this.query).all(...this.values as never[]) as T[], meta: { changes: 0 } }; }
  async run<T>() { const result = this.owner.sqlite.prepare(this.query).run(...this.values as never[]); return { results: [] as T[], meta: { changes: Number(result.changes) } }; }
  execute(): Promise<D1Result> { return /^\s*(SELECT|WITH|PRAGMA)\b/iu.test(this.query) ? this.all() : this.run(); }
}
class Database implements D1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  nextEpochRead?: () => void;
  prepare(query: string) { return new Statement(this, query); }
  async batch(statements: D1Statement[]) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try { const result: D1Result[] = []; for (const statement of statements) result.push(await (statement as Statement).execute()); this.sqlite.exec("COMMIT"); return result; }
    catch (cause) { this.sqlite.exec("ROLLBACK"); throw cause; }
  }
}
const base = "https://app.example.test", provider = "https://api.openai.com/v1/chat/completions", secret = "sk-cloud-study-fixture";
function fixture() {
  const db = new Database(); db.sqlite.exec("PRAGMA foreign_keys=ON");
  const directory = new URL("../cloud/migrations/", import.meta.url);
  for (const name of readdirSync(directory).filter((name) => /^\d+_.+\.sql$/u.test(name)).sort()) db.sqlite.exec(readFileSync(new URL(name, directory), "utf8"));
  db.sqlite.prepare("UPDATE app_settings SET value=?,revision=1 WHERE key='llm_settings'").run(JSON.stringify({ enabled: true, target: "remote", remote: { endpointUrl: provider, model: "fake" }, local: { endpointUrl: "", model: "", trusted: false } }));
  const stamp = "2026-10-26T00:00:00.000Z";
  db.sqlite.prepare("INSERT INTO cloud_documents(id,title,source_url,markdown,status,source_note,revision,created_at,updated_at) VALUES ('source','Evidence source','https://source.example.test/original','The nebularity evidence is confirmed by the measured signal.','ready','',3,?,?)").run(stamp, stamp);
  const env = { DB: db } as CloudEnv;
  const headers = () => ({ "Content-Type": "application/json", "X-Zhiye-Data-Epoch": String(db.sqlite.prepare("SELECT value FROM app_settings WHERE key='data_epoch'").get()?.value), "X-Zhiye-LLM-Key": secret });
  const call = (path: string, method = "GET", body?: unknown) => handleRequest(new Request(base + path, { method, headers: headers(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
  const topic = async () => {
    const created = await call("/api/study/topics", "POST", { name: "Evidence topic" }); assert.equal(created.status, 200, await created.clone().text());
    const first = await created.json() as StudyTopicDetail;
    const added = await call(`/api/study/topics/${first.id}`, "PATCH", { revision: first.revision, documentId: "source" }); assert.equal(added.status, 200, await added.clone().text());
    return await added.json() as StudyTopicDetail;
  };
  return { db, env, call, headers, topic };
}
const questionBody = (topic: StudyTopicDetail, question = "What does the nebularity evidence say?") => ({ question, topicRevision: topic.revision, settingsRevision: 1, scope: topic.documents.map(({ id, revision }) => ({ id, revision })) });
function modelResponse(content: string) { return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }), { headers: { "Content-Type": "application/json" } }); }
function suppliedId(init?: RequestInit) { const request = JSON.parse(String(init?.body)); const data = JSON.parse(request.messages[1].content); return String(data.evidence[0].id); }

test("cloud study topic questions cite scoped evidence and refuse missing evidence without contacting a model", async () => {
  const f = fixture(), originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), provider); assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${secret}`); calls += 1;
    const id = suppliedId(init); return modelResponse(JSON.stringify({ answer: `The measured signal confirms the result [${id}]`, citations: [id], refused: false }));
  };
  try {
    const topic = await f.topic(), answered = await f.call(`/api/study/topics/${topic.id}/ask`, "POST", questionBody(topic));
    assert.equal(answered.status, 200, await answered.clone().text());
    const body = await answered.json() as { answer: string; citations: Array<{ documentId: string; documentRevision: number; anchor: { quote: string } }>; refused: boolean };
    assert.equal(body.refused, false); assert.equal(body.citations[0]?.documentId, "source"); assert.equal(body.citations[0]?.documentRevision, 3); assert.ok(body.citations[0]?.anchor.quote.includes("nebularity evidence")); assert.equal(calls, 1);
    const refused = await f.call(`/api/study/topics/${topic.id}/ask`, "POST", questionBody(topic, "Explain xylophonic quasar transduction."));
    assert.equal(refused.status, 200); assert.equal((await refused.json() as { refused: boolean }).refused, true); assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; f.db.sqlite.close(); }
});

test("cloud study rejects unknown and missing inline citations from a model", async () => {
  const f = fixture(), originalFetch = globalThis.fetch;
  let response: "unknown" | "missing" = "unknown";
  globalThis.fetch = async (url, init) => { assert.equal(String(url), provider); const id = suppliedId(init); return modelResponse(JSON.stringify(response === "unknown" ? { answer: "An invented reference [outside]", citations: ["outside"], refused: false } : { answer: "A statement with no inline reference", citations: [id], refused: false })); };
  try {
    const topic = await f.topic();
    for (const mode of ["unknown", "missing"] as const) { response = mode; const rejected = await f.call(`/api/study/topics/${topic.id}/ask`, "POST", questionBody(topic)); assert.equal(rejected.status, 400); assert.equal((await rejected.json() as { error: { code: string } }).error.code, "INVALID_STUDY_REQUEST"); }
  } finally { globalThis.fetch = originalFetch; f.db.sqlite.close(); }
});

test("cloud study discards a credential escaped inside the model's nested answer JSON", async () => {
  const f = fixture(), originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), provider); const id = suppliedId(init);
    const output = JSON.stringify({ answer: `Credential ${secret} [${id}]`, citations: [id], refused: false }).replace(secret, "\\u0073" + secret.slice(1));
    assert.equal(output.includes(secret), false); return modelResponse(output);
  };
  try { const topic = await f.topic(), rejected = await f.call(`/api/study/topics/${topic.id}/ask`, "POST", questionBody(topic)); assert.equal(rejected.status, 502); const text = await rejected.text(); assert.equal(JSON.parse(text).error.code, "LLM_SECRET_ECHO"); assert.ok(!text.includes(secret)); assert.ok(!text.includes("\\u0073")); }
  finally { globalThis.fetch = originalFetch; f.db.sqlite.close(); }
});

for (const action of ["question", "source"] as const) test(`cloud study ${action} with a slow POST body cannot send data after the initial epoch changes`, async () => {
  const f = fixture(), originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("No network request is allowed after a stale epoch"); };
  try {
    const topic = await f.topic(), body = JSON.stringify(action === "question" ? questionBody(topic) : { revision: 3 });
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder(), middle = Math.floor(body.length / 2);
    const input = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; controller.enqueue(encoder.encode(body.slice(0, middle))); } });
    let epochRead = () => {};
    const ready = new Promise<void>((resolve) => { epochRead = resolve; }); f.db.nextEpochRead = epochRead;
    const path = action === "question" ? `/api/study/topics/${topic.id}/ask` : "/api/study/documents/source/check-source";
    const request = new Request(base + path, { method: "POST", headers: f.headers(), body: input, duplex: "half" } as RequestInit & { duplex: "half" });
    const pending = handleRequest(request, f.env);
    await ready;
    f.db.sqlite.prepare("UPDATE app_settings SET value='cloud-restored',revision=revision+1 WHERE key='data_epoch'").run();
    stream.enqueue(encoder.encode(body.slice(middle))); stream.close();
    const rejected = await pending; assert.equal(rejected.status, 409, await rejected.clone().text()); assert.equal((await rejected.json() as { error: { code: string } }).error.code, "STALE_DATA_EPOCH"); assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; f.db.sqlite.close(); }
});

test("cloud study source checks treat 401/403 as restricted and never follow a redirect to a private address", async () => {
  const f = fixture(), originalFetch = globalThis.fetch;
  let status = 401;
  const targets: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "cloudflare-dns.com") return new Response(JSON.stringify({ Answer: url.searchParams.get("type") === "A" ? [{ type: 1, data: "8.8.8.8" }] : [] }), { headers: { "Content-Type": "application/json" } });
    targets.push(url.href); assert.equal(url.hostname, "source.example.test"); assert.equal(init?.method, "HEAD"); assert.equal(new Headers(init?.headers).get("Authorization"), null);
    return new Response(null, { status, ...(status === 302 ? { headers: { Location: "http://127.0.0.1/private" } } : {}) });
  };
  try {
    for (const code of [401, 403]) { status = code; const checked = await f.call("/api/study/documents/source/check-source", "POST", { revision: 3 }); assert.equal(checked.status, 200, await checked.clone().text()); const result = await checked.json() as { state: string; status: number }; assert.equal(result.state, "restricted"); assert.equal(result.status, code); }
    status = 302; targets.length = 0;
    const redirected = await f.call("/api/study/documents/source/check-source", "POST", { revision: 3 }); assert.equal(redirected.status, 200); const result = await redirected.json() as { state: string; status: number | null; message: string }; assert.equal(result.state, "unknown"); assert.equal(result.status, null); assert.match(result.message, /公开网络/u); assert.deepEqual(targets, ["https://source.example.test/original"]);
    assert.equal(f.db.sqlite.prepare("SELECT state FROM study_source_checks WHERE document_id='source'").get()?.state, "unknown");
  } finally { globalThis.fetch = originalFetch; f.db.sqlite.close(); }
});
