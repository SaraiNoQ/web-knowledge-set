import { randomUUID } from "node:crypto";

import type { SemanticIndexStepResult } from "../shared/types.js";
import {
  aggregateSemanticVectors,
  DEFAULT_SEMANTIC_MODEL,
  embedSemanticTexts,
  SemanticEmbeddingError,
  semanticHash,
  SEMANTIC_CHUNKS_PER_STEP,
  SEMANTIC_FORMAT_VERSION,
  splitSemanticSections,
} from "../shared/semantic.js";
import type { KnowledgeDatabase } from "./db.js";

export class SemanticError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "SemanticError";
  }
}

export class SemanticTasks {
  constructor(private readonly database: () => KnowledgeDatabase, private readonly apiKey: () => string | null) {}

  settings(includeEstimate = false) {
    return this.database().getSemanticSettings(Boolean(this.apiKey()), includeEstimate);
  }

  apiKeyStatus() {
    return { configured: Boolean(this.apiKey()), endpointUrl: this.apiKey() ? "https://api.siliconflow.cn/v1/embeddings" : null };
  }

  async test(model: string, signal?: AbortSignal) {
    const key = this.apiKey();
    if (!key) throw new SemanticError(409, "SEMANTIC_KEY_MISSING", "Set the embedding API key before testing the model");
    try {
      const vectors = await embedSemanticTexts(model, key, ["织页知识地图连接测试"], signal);
      return { ok: true as const, model, dimension: vectors[0]!.length };
    } catch (cause) {
      if (cause instanceof SemanticEmbeddingError) throw new SemanticError(
        cause.code === "INVALID_SEMANTIC_REQUEST" ? 400 : cause.code === "SEMANTIC_AUTH_FAILED" ? 401 : cause.code === "SEMANTIC_RATE_LIMITED" ? 429 : 502,
        cause.code,
        cause.message,
      );
      throw cause;
    }
  }

  async step(signal?: AbortSignal, isCurrent: () => boolean = () => true): Promise<SemanticIndexStepResult> {
    const db = this.database();
    const assertCurrent = () => {
      if (!isCurrent()) throw new SemanticError(409, "STALE_DATA_EPOCH", "Knowledge-base data changed; reload before indexing");
    };
    const settings = db.getSemanticSettings(Boolean(this.apiKey()));
    if (!settings.enabled) return this.result("idle", null);
    const key = this.apiKey();
    if (!key) throw new SemanticError(409, "SEMANTIC_KEY_MISSING", "Set the embedding API key before indexing");
    const id = db.nextSemanticDocument(Date.now(), settings.model, SEMANTIC_FORMAT_VERSION);
    if (!id) return this.result("idle", null);
    const source = db.getSemanticSource(id);
    if (!source) return this.result("idle", id);
    const chunks = await splitSemanticSections(source.sections);
    const sourceHash = await semanticHash(JSON.stringify([source.title, source.sections.map((section) => [section.pageNumber, section.text])]));
    assertCurrent();
    const token = randomUUID();
    const now = Date.now();
    if (!db.claimSemanticIndex(id, source.revision, source.extractionId, settings.revision, sourceHash,
      settings.model, SEMANTIC_FORMAT_VERSION, chunks.length, token, now, now + 90_000)) {
      return this.result("busy", id);
    }
    try {
      if (!chunks.length) {
        db.failSemanticIndex(id, source.revision, source.extractionId, settings.revision, settings.model, token, "SEMANTIC_EMPTY_CONTENT");
        return this.result("failed", id, "SEMANTIC_EMPTY_CONTENT");
      }
      const missing = db.missingSemanticChunks(id, chunks.length);
      if (missing.length) {
        const batchIndexes = missing.slice(0, SEMANTIC_CHUNKS_PER_STEP);
        const title = Array.from(source.title).slice(0, 128).join("");
        const inputs = batchIndexes.map((index) => title + "\n\n" + chunks[index]!.text);
        const vectors = await embedSemanticTexts(settings.model, key, inputs, signal);
        assertCurrent();
        if (!db.saveSemanticChunks(id, source.revision, source.extractionId, settings.revision, sourceHash,
          settings.model, SEMANTIC_FORMAT_VERSION, token,
          batchIndexes.map((index, offset) => ({ chunk: chunks[index]!, vector: vectors[offset]! })))) {
          db.releaseSemanticLease(id, token);
          return this.result("busy", id);
        }
      }
      const remaining = db.missingSemanticChunks(id, chunks.length);
      if (!remaining.length) {
        const vector = aggregateSemanticVectors(db.semanticChunks(id), chunks);
        assertCurrent();
        if (db.completeSemanticIndex(id, source.revision, source.extractionId, settings.revision, sourceHash,
          settings.model, SEMANTIC_FORMAT_VERSION, token, vector)) {
          db.recordSemanticSuccess();
          return this.result("completed", id);
        }
        db.releaseSemanticLease(id, token);
        return this.result("busy", id);
      }
      db.releaseSemanticLease(id, token);
      return this.result("progress", id);
    } catch (cause) {
      if (!isCurrent() || signal?.aborted) {
        try { db.releaseSemanticLease(id, token); } catch { /* restore may have closed the old database handle */ }
        if (!isCurrent()) throw new SemanticError(409, "STALE_DATA_EPOCH", "Knowledge-base data changed; reload before indexing");
        throw signal?.reason ?? cause;
      }
      if (cause instanceof SemanticError) throw cause;
      const code = cause instanceof SemanticEmbeddingError ? cause.code : "SEMANTIC_INDEX_FAILED";
      if (!db.failSemanticIndex(id, source.revision, source.extractionId, settings.revision, settings.model, token, code)) {
        db.releaseSemanticLease(id, token);
      }
      if (cause instanceof SemanticEmbeddingError) throw new SemanticError(
        code === "SEMANTIC_AUTH_FAILED" ? 401 : code === "SEMANTIC_RATE_LIMITED" ? 429 : 502,
        code,
        cause.message,
      );
      throw new SemanticError(502, code, "Semantic indexing failed");
    }
  }

  retryFailures() {
    return this.database().retrySemanticFailures();
  }

  rebuild() {
    const db = this.database();
    return db.clearSemanticIndexes();
  }

  vectors(cursor: number, limit: number) {
    const settings = this.settings();
    return settings.enabled ? this.database().semanticVectorPage(cursor, limit, settings.model, SEMANTIC_FORMAT_VERSION) : { items: [], total: 0, nextCursor: null };
  }

  private result(status: SemanticIndexStepResult["status"], documentId: string | null, errorCode: string | null = null) {
    const settings = this.settings();
    return {
      status, documentId, completedChunks: settings.completedChunks, totalChunks: settings.totalChunks,
      pendingDocuments: settings.pendingDocuments, errorCode,
    };
  }
}

export const defaultSemanticModel = DEFAULT_SEMANTIC_MODEL;

export function semanticApiKeyInput(body: Record<string, unknown>) {
  if (Object.keys(body).length !== 1 || typeof body.apiKey !== "string") {
    throw new SemanticError(400, "INVALID_SEMANTIC_KEY", "apiKey must be a string");
  }
  const apiKey = body.apiKey.trim();
  if (!apiKey || new TextEncoder().encode(apiKey).byteLength > 16 * 1024 || /\p{Cc}/u.test(apiKey)) {
    throw new SemanticError(400, "INVALID_SEMANTIC_KEY", "apiKey must be non-empty and contain no control characters");
  }
  return apiKey;
}

export function semanticSettingsInput(body: Record<string, unknown>) {
  if (Object.keys(body).some((key) => !["enabled", "model", "revision"].includes(key)) ||
    typeof body.enabled !== "boolean" || typeof body.model !== "string" || !Number.isSafeInteger(body.revision) || Number(body.revision) < 0) {
    throw new SemanticError(400, "INVALID_SEMANTIC_SETTINGS", "enabled, model, and revision are required");
  }
  const model = body.model.trim();
  if (!model || model.length > 200 || /\p{Cc}/u.test(model)) {
    throw new SemanticError(400, "INVALID_SEMANTIC_SETTINGS", "model must contain 1-200 characters without controls");
  }
  return { enabled: body.enabled, model, revision: Number(body.revision) };
}
