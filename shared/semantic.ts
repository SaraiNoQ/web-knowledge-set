export const SEMANTIC_EMBEDDINGS_URL = "https://api.siliconflow.cn/v1/embeddings";
export const SEMANTIC_KEY_HEADER = "X-Zhiye-Embedding-Key";
export const DEFAULT_SEMANTIC_MODEL = "BAAI/bge-m3";
export const SEMANTIC_CHUNK_SIZE = 1_500;
export const SEMANTIC_CHUNK_OVERLAP = 150;
export const SEMANTIC_CHUNK_ADVANCE = SEMANTIC_CHUNK_SIZE - SEMANTIC_CHUNK_OVERLAP;
export const SEMANTIC_CHUNKS_PER_STEP = 4;
export const SEMANTIC_FORMAT_VERSION = "semantic-text-v1";
export const SEMANTIC_RETRY_DELAYS_MS = [60_000, 5 * 60_000] as const;
export const SEMANTIC_MAX_ATTEMPTS = SEMANTIC_RETRY_DELAYS_MS.length + 1;
const MAX_EMBEDDING_DIMENSION = 4_096;
const MAX_EMBEDDING_RESPONSE_BYTES = 8 * 1024 * 1024;

export function isRetryableSemanticError(code: string) {
  return code === "SEMANTIC_NETWORK_ERROR" || code === "SEMANTIC_RATE_LIMITED" || code === "SEMANTIC_PROVIDER_UNAVAILABLE";
}

export function estimateSemanticChunkCount(codePoints: number) {
  if (!Number.isSafeInteger(codePoints) || codePoints <= 0) return 0;
  return 1 + Math.ceil(Math.max(0, codePoints - SEMANTIC_CHUNK_SIZE) / SEMANTIC_CHUNK_ADVANCE);
}

export interface SemanticSourceSection {
  pageNumber: number | null;
  text: string;
}

export interface SemanticChunk {
  index: number;
  pageNumber: number | null;
  startOffset: number;
  endOffset: number;
  textHash: string;
  text: string;
  weight: number;
}

export class SemanticEmbeddingError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SemanticEmbeddingError";
  }
}

export const SEMANTIC_VECTOR_IDS_PER_REQUEST = 100;

export function parseSemanticVectorIds(value: string | null): string[] | undefined {
  if (value === null) return undefined;
  if (value.length > 24_000) throw new SemanticEmbeddingError("INVALID_SEMANTIC_PAGE", "Vector id filter is too large");
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new SemanticEmbeddingError("INVALID_SEMANTIC_PAGE", "Vector id filter is invalid"); }
  if (!Array.isArray(parsed) || parsed.length > SEMANTIC_VECTOR_IDS_PER_REQUEST ||
    parsed.some((id) => typeof id !== "string" || !id.trim() || id.length > 200 || /\p{Cc}/u.test(id)) ||
    new Set(parsed).size !== parsed.length) {
    throw new SemanticEmbeddingError("INVALID_SEMANTIC_PAGE", "Vector id filter is invalid");
  }
  return parsed as string[];
}

export async function semanticHash(value: string) {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function extractSemanticMarkdown(markdown: string) {
  return markdown
    .replace(/^```[^\n]*\n/gu, "")
    .replace(/^```\s*$/gmu, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, " $1 ")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, " $1 ")
    .replace(/^#{1,6}\s+/gmu, "")
    .replace(/^\s*>+\s?/gmu, "")
    .replace(/<[^>]+>/gu, " ")
    .replace(/[`*_~]+/gu, "")
    .replace(/[\t ]+/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function chunkEnd(chars: string[], start: number) {
  let end = Math.min(start + SEMANTIC_CHUNK_SIZE, chars.length);
  if (end === chars.length) return end;
  for (let index = end - 1; index >= start + Math.floor(SEMANTIC_CHUNK_SIZE * .55); index -= 1) {
    if (chars[index] === "\n" || chars[index] === "。" || chars[index] === "！" || chars[index] === "？" || chars[index] === ".") return index + 1;
  }
  return end;
}

export async function splitSemanticSections(sections: SemanticSourceSection[]): Promise<SemanticChunk[]> {
  const chunks: SemanticChunk[] = [];
  for (const section of sections) {
    const chars = Array.from(section.text);
    let start = 0;
    while (start < chars.length) {
      const end = chunkEnd(chars, start);
      const text = chars.slice(start, end).join("");
      if (text.trim()) {
        const previous = chunks.at(-1);
        const overlap = previous?.pageNumber === section.pageNumber && previous.endOffset > previous.startOffset
          ? Math.min(SEMANTIC_CHUNK_OVERLAP, Math.max(0, end - start - 1))
          : 0;
        chunks.push({
          index: chunks.length, pageNumber: section.pageNumber, startOffset: start, endOffset: end,
          textHash: await semanticHash(text), text, weight: Math.max(1, end - start - overlap),
        });
      }
      if (end >= chars.length) break;
      start = Math.max(start + 1, end - SEMANTIC_CHUNK_OVERLAP);
    }
  }
  return chunks;
}

async function boundedText(response: Response) {
  const declared = response.headers.get("Content-Length");
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > MAX_EMBEDDING_RESPONSE_BYTES)) {
    throw new SemanticEmbeddingError("SEMANTIC_RESPONSE_TOO_LARGE", "The embedding response exceeded its size limit");
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_EMBEDDING_RESPONSE_BYTES) {
        await reader.cancel();
        throw new SemanticEmbeddingError("SEMANTIC_RESPONSE_TOO_LARGE", "The embedding response exceeded its size limit");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}

async function embedSemanticTextsOnce(
  model: string,
  apiKey: string,
  texts: string[],
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  if (!model.trim() || model.length > 200 || /\p{Cc}/u.test(model) || !texts.length || texts.length > SEMANTIC_CHUNKS_PER_STEP) {
    throw new SemanticEmbeddingError("INVALID_SEMANTIC_REQUEST", "The embedding request was invalid");
  }
  if (!apiKey.trim() || new TextEncoder().encode(apiKey).byteLength > 16 * 1024 || /\p{Cc}/u.test(apiKey)) {
    throw new SemanticEmbeddingError("SEMANTIC_KEY_INVALID", "An embedding API key is required");
  }
  let response: Response;
  try {
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
    response = await fetcher(SEMANTIC_EMBEDDINGS_URL, {
      method: "POST", redirect: "error",
      headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ model: model.trim(), input: texts, encoding_format: "float" }),
      signal: requestSignal,
    });
  } catch {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    throw new SemanticEmbeddingError("SEMANTIC_NETWORK_ERROR", "The embedding provider could not be reached");
  }
  if (response.status === 401 || response.status === 403) throw new SemanticEmbeddingError("SEMANTIC_AUTH_FAILED", "The embedding API key was rejected");
  if (response.status === 429) throw new SemanticEmbeddingError("SEMANTIC_RATE_LIMITED", "The embedding provider is rate limiting requests");
  if (response.status === 413) throw new SemanticEmbeddingError("SEMANTIC_INPUT_TOO_LARGE", "The embedding provider rejected the input size");
  if (response.status === 408 || response.status >= 500) throw new SemanticEmbeddingError("SEMANTIC_PROVIDER_UNAVAILABLE", "The embedding provider is temporarily unavailable");
  if (response.status === 400 || response.status === 422) {
    const detail = await boundedText(response);
    if (detail.includes(apiKey)) throw new SemanticEmbeddingError("SEMANTIC_PROVIDER_FAILED", "The embedding provider rejected the request");
    if (/(?:input|text|token|prompt).{0,60}(?:length|size|long|exceed|maximum|limit)|(?:length|size|long|exceed|maximum|limit).{0,60}(?:input|text|token|prompt)/iu.test(detail)) {
      throw new SemanticEmbeddingError("SEMANTIC_INPUT_TOO_LARGE", "The embedding provider rejected the input size");
    }
    throw new SemanticEmbeddingError("SEMANTIC_PROVIDER_FAILED", "The embedding provider rejected the request");
  }
  if (!response.ok) throw new SemanticEmbeddingError("SEMANTIC_PROVIDER_FAILED", "The embedding provider rejected the request");

  const body = await boundedText(response);
  if (body.includes(apiKey)) throw new SemanticEmbeddingError("SEMANTIC_SECRET_ECHO", "The provider response contained a credential");
  let data: unknown;
  try { data = (JSON.parse(body) as { data?: unknown }).data; }
  catch { throw new SemanticEmbeddingError("SEMANTIC_INVALID_RESPONSE", "The embedding response was not valid JSON"); }
  if (!Array.isArray(data) || data.length !== texts.length) throw new SemanticEmbeddingError("SEMANTIC_INVALID_RESPONSE", "The embedding response did not match the request");
  const ordered: number[][] = Array(texts.length);
  for (const item of data) {
    if (!item || typeof item !== "object") throw new SemanticEmbeddingError("SEMANTIC_INVALID_RESPONSE", "An embedding result was invalid");
    const row = item as { index?: unknown; embedding?: unknown };
    if (!Number.isSafeInteger(row.index) || Number(row.index) < 0 || Number(row.index) >= texts.length ||
      ordered[Number(row.index)] || !Array.isArray(row.embedding) || !row.embedding.length || row.embedding.length > MAX_EMBEDDING_DIMENSION ||
      row.embedding.some((value) => typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 100)) {
      throw new SemanticEmbeddingError("SEMANTIC_INVALID_RESPONSE", "An embedding vector was invalid");
    }
    ordered[Number(row.index)] = row.embedding as number[];
  }
  const dimension = ordered[0]?.length;
  if (!dimension || ordered.some((vector) => vector?.length !== dimension)) {
    throw new SemanticEmbeddingError("SEMANTIC_INVALID_RESPONSE", "Embedding vector dimensions did not match");
  }
  return ordered;
}

async function adaptiveEmbed(model: string, apiKey: string, texts: string[], signal: AbortSignal | undefined, fetcher: typeof fetch): Promise<number[][]> {
  try {
    return await embedSemanticTextsOnce(model, apiKey, texts, signal, fetcher);
  } catch (cause) {
    if (!(cause instanceof SemanticEmbeddingError) || cause.code !== "SEMANTIC_INPUT_TOO_LARGE" || signal?.aborted) throw cause;
    if (texts.length > 1) {
      const middle = Math.ceil(texts.length / 2);
      return [
        ...await adaptiveEmbed(model, apiKey, texts.slice(0, middle), signal, fetcher),
        ...await adaptiveEmbed(model, apiKey, texts.slice(middle), signal, fetcher),
      ];
    }
    const chars = Array.from(texts[0] ?? "");
    if (chars.length <= 128) throw cause;
    const middle = Math.floor(chars.length / 2);
    const overlap = Math.min(64, Math.floor(chars.length / 10));
    const [left, right] = await Promise.all([
      adaptiveEmbed(model, apiKey, [chars.slice(0, middle + overlap).join("")], signal, fetcher),
      adaptiveEmbed(model, apiKey, [chars.slice(middle - overlap).join("")], signal, fetcher),
    ]);
    const vector = left[0]!.map((value, index) => (value + right[0]![index]!) / 2);
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (!Number.isFinite(norm) || norm === 0) throw new SemanticEmbeddingError("SEMANTIC_INVALID_RESPONSE", "Embedding vector norm was invalid");
    return [vector.map((value) => value / norm)];
  }
}

export async function embedSemanticTexts(
  model: string,
  apiKey: string,
  texts: string[],
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  return await adaptiveEmbed(model, apiKey, texts, signal, fetcher);
}

export function aggregateSemanticVectors(vectors: number[][], chunks: SemanticChunk[]) {
  if (!vectors.length || vectors.length !== chunks.length) throw new SemanticEmbeddingError("SEMANTIC_INVALID_RESPONSE", "Semantic vectors are incomplete");
  const dimension = vectors[0]?.length;
  if (!dimension || vectors.some((vector) => vector.length !== dimension)) throw new SemanticEmbeddingError("SEMANTIC_INVALID_RESPONSE", "Semantic vector dimensions differ");
  const result = Array<number>(dimension).fill(0);
  let totalWeight = 0;
  vectors.forEach((vector, index) => {
    const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (!Number.isFinite(magnitude) || magnitude === 0 || vector.some((value) => !Number.isFinite(value))) {
      throw new SemanticEmbeddingError("SEMANTIC_INVALID_RESPONSE", "Semantic vector norm is invalid");
    }
    const weight = chunks[index]!.weight;
    if (!Number.isFinite(weight) || weight <= 0) throw new SemanticEmbeddingError("SEMANTIC_INVALID_RESPONSE", "Semantic chunk weight is invalid");
    for (let axis = 0; axis < dimension; axis += 1) result[axis]! += vector[axis]! / magnitude * weight;
    totalWeight += weight;
  });
  const average = result.map((value) => value / totalWeight);
  const magnitude = Math.sqrt(average.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(magnitude) || magnitude === 0) throw new SemanticEmbeddingError("SEMANTIC_INVALID_RESPONSE", "Semantic vector norm is invalid");
  return average.map((value) => value / magnitude);
}
