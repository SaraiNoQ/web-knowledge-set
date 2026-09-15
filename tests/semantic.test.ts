import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "../server/db.js";
import { SemanticError, SemanticTasks } from "../server/semantic.js";
import {
  aggregateSemanticVectors,
  embedSemanticTexts,
  estimateSemanticChunkCount,
  SEMANTIC_CHUNKS_PER_STEP,
  SEMANTIC_CHUNK_ADVANCE,
  SEMANTIC_CHUNK_OVERLAP,
  SEMANTIC_CHUNK_SIZE,
  SEMANTIC_EMBEDDINGS_URL,
  SEMANTIC_FORMAT_VERSION,
  isRetryableSemanticError,
  SemanticEmbeddingError,
  splitSemanticSections,
} from "../shared/semantic.js";

test("semantic chunking keeps Unicode text, bounded sizes, overlap, and paper page anchors", async () => {
  const article = "研究🙂".repeat(600);
  const chunks = await splitSemanticSections([
    { pageNumber: 1, text: article },
    { pageNumber: 2, text: "第二页原文" },
  ]);
  assert.ok(chunks.length > 2);
  assert.ok(chunks.every((chunk) => Array.from(chunk.text).length <= SEMANTIC_CHUNK_SIZE));
  const firstPage = chunks.filter((chunk) => chunk.pageNumber === 1);
  assert.equal(firstPage[0]?.startOffset, 0);
  for (let index = 1; index < firstPage.length; index += 1) {
    assert.equal(firstPage[index]!.startOffset, firstPage[index - 1]!.endOffset - SEMANTIC_CHUNK_OVERLAP);
  }
  const reconstructed = firstPage.map((chunk, index) => Array.from(chunk.text).slice(index ? SEMANTIC_CHUNK_OVERLAP : 0).join("")).join("");
  assert.equal(reconstructed, article);
  assert.equal(chunks.at(-1)?.pageNumber, 2);
});

test("semantic chunk estimates account for the initial chunk and overlap advance", () => {
  assert.equal(estimateSemanticChunkCount(0), 0);
  assert.equal(estimateSemanticChunkCount(SEMANTIC_CHUNK_SIZE), 1);
  assert.equal(estimateSemanticChunkCount(SEMANTIC_CHUNK_SIZE + 1), 2);
  assert.equal(estimateSemanticChunkCount(SEMANTIC_CHUNK_SIZE + SEMANTIC_CHUNK_ADVANCE), 2);
  assert.equal(estimateSemanticChunkCount(SEMANTIC_CHUNK_SIZE + SEMANTIC_CHUNK_ADVANCE + 1), 3);
  assert.equal(estimateSemanticChunkCount(Number.NaN), 0);
});

test("embedding client pins the HTTPS provider, caps each batch, and validates unordered vectors", async () => {
  let requestedUrl = "";
  let authorization = "";
  let inputs: string[] = [];
  const vectors = await embedSemanticTexts("BAAI/bge-m3", "test-secret", ["one", "two"], undefined, async (url, init) => {
    requestedUrl = String(url);
    authorization = new Headers(init?.headers).get("Authorization") || "";
    inputs = (JSON.parse(String(init?.body)) as { input: string[] }).input;
    assert.equal(init?.redirect, "manual");
    return new Response(JSON.stringify({ data: [
      { index: 1, embedding: [0, 1] },
      { index: 0, embedding: [1, 0] },
    ] }), { headers: { "Content-Type": "application/json" } });
  });
  assert.equal(requestedUrl, SEMANTIC_EMBEDDINGS_URL);
  assert.equal(authorization, "Bearer test-secret");
  assert.deepEqual(inputs, ["one", "two"]);
  assert.deepEqual(vectors, [[1, 0], [0, 1]]);
  await assert.rejects(embedSemanticTexts("model", "key", Array(SEMANTIC_CHUNKS_PER_STEP + 1).fill("text")), SemanticEmbeddingError);
});

test("embedding client rejects provider credentials, malformed dimensions, and non-finite values", async () => {
  const unauthorized = async () => new Response("{}", { status: 401 });
  await assert.rejects(embedSemanticTexts("model", "key", ["text"], undefined, unauthorized), (error: unknown) =>
    error instanceof SemanticEmbeddingError && error.code === "SEMANTIC_AUTH_FAILED");
  const mismatched = async () => new Response(JSON.stringify({ data: [
    { index: 0, embedding: [1, 0] }, { index: 1, embedding: [1] },
  ] }));
  await assert.rejects(embedSemanticTexts("model", "key", ["a", "b"], undefined, mismatched), (error: unknown) =>
    error instanceof SemanticEmbeddingError && error.code === "SEMANTIC_INVALID_RESPONSE");
});

test("embedding transport diagnostics omit API keys, input text, and raw errors", async () => {
  const originalError = console.error;
  const logs: string[] = [];
  console.error = (...values: unknown[]) => logs.push(values.map(String).join(" "));
  try {
    await assert.rejects(
      embedSemanticTexts("model", "api-secret", ["private article text"], undefined, async () => {
        throw new TypeError("fetch failed: api-secret private article text");
      }),
      (error: unknown) => error instanceof SemanticEmbeddingError && error.code === "SEMANTIC_NETWORK_ERROR",
    );
  } finally {
    console.error = originalError;
  }
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /TypeError/u);
  assert.match(logs[0]!, /"timedOut":false/u);
  assert.doesNotMatch(logs[0]!, /api-secret|private article text|fetch failed/u);
});

test("embedding client refuses a provider redirect instead of following it", async () => {
  let calls = 0;
  const redirecting = async () => {
    calls += 1;
    return new Response("", { status: 302, headers: { Location: "https://elsewhere.example.com/v1/embeddings" } });
  };
  await assert.rejects(embedSemanticTexts("model", "key", ["text"], undefined, redirecting), (error: unknown) =>
    error instanceof SemanticEmbeddingError && error.code === "SEMANTIC_REDIRECT_REJECTED");
  assert.equal(calls, 1);
  // A redirect cannot fix itself, so it must not spend the backoff retries.
  assert.equal(isRetryableSemanticError("SEMANTIC_REDIRECT_REJECTED"), false);
});

test("embedding client bisects provider-rejected long inputs and still returns one vector per chunk", async () => {
  let calls = 0;
  const vectors = await embedSemanticTexts("model", "key", ["长文本".repeat(300)], undefined, async (_url, init) => {
    calls += 1;
    const input = (JSON.parse(String(init?.body)) as { input: string[] }).input[0]!;
    if (Array.from(input).length > 500) return new Response("input length exceeds maximum", { status: 400 });
    return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 1] }] }));
  });
  assert.ok(calls > 1);
  assert.equal(vectors.length, 1);
  assert.ok(Math.abs(Math.hypot(...vectors[0]!) - 1) < 1e-12);
});

test("document embedding aggregation is length weighted and normalized", () => {
  const vector = aggregateSemanticVectors([[1, 0], [0, 1]], [
    { index: 0, pageNumber: null, startOffset: 0, endOffset: 3, textHash: "a", text: "abc", weight: 3 },
    { index: 1, pageNumber: null, startOffset: 2, endOffset: 5, textHash: "b", text: "cde", weight: 2 },
  ]);
  assert.ok(Math.abs(vector[0]! - 3 / Math.sqrt(13)) < 1e-12);
  assert.ok(Math.abs(vector[1]! - 2 / Math.sqrt(13)) < 1e-12);
  assert.deepEqual(aggregateSemanticVectors([[2, 0], [0, 5]], [
    { index: 0, pageNumber: null, startOffset: 0, endOffset: 3, textHash: "a", text: "abc", weight: 3 },
    { index: 1, pageNumber: null, startOffset: 2, endOffset: 5, textHash: "b", text: "cde", weight: 2 },
  ]), vector);
  assert.throws(() => aggregateSemanticVectors([[0, 0]], [
    { index: 0, pageNumber: null, startOffset: 0, endOffset: 1, textHash: "c", text: "a", weight: 1 },
  ]), (cause: unknown) => cause instanceof SemanticEmbeddingError && cause.code === "SEMANTIC_INVALID_RESPONSE");
});

test("local indexing discards provider results after the data epoch changes", async () => {
  const originalFetch = globalThis.fetch;
  const directory = mkdtempSync(join(tmpdir(), "zhiye-semantic-epoch-"));
  const db = openDatabase(directory);
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let finish!: () => void;
  const providerResponse = new Promise<Response>((resolve) => {
    finish = () => resolve(new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.6, 0.8] }] })));
  });
  let current = true;
  let pending: Promise<unknown> | null = null;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), SEMANTIC_EMBEDDINGS_URL);
    markStarted();
    return await providerResponse;
  };
  try {
    const article = db.createArticle("Epoch-bound article");
    assert.equal(db.updateDocument(article.id, article.revision, { markdown: "正文内容" }).kind, "updated");
    assert.equal(db.setSemanticSettings({ enabled: true, model: "BAAI/bge-m3", revision: 0 }, true).kind, "updated");
    const tasks = new SemanticTasks(() => db, () => "test-key");
    pending = tasks.step(undefined, () => current);
    await started;
    current = false;
    finish();
    await assert.rejects(pending, (cause: unknown) => cause instanceof SemanticError && cause.code === "STALE_DATA_EPOCH");
    assert.deepEqual(db.semanticVectorPage(0, 10, "BAAI/bge-m3", SEMANTIC_FORMAT_VERSION).items, []);
    assert.deepEqual(db.semanticChunks(article.id), []);
  } finally {
    finish();
    await pending?.catch(() => undefined);
    globalThis.fetch = originalFetch;
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
