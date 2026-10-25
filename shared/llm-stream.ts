export class LlmStreamError extends Error { constructor(readonly code: string) { super(code); } }

export async function consumeCompletionStream(chunks: AsyncIterable<Uint8Array>, apiKey: string, onText: (text: string) => void | Promise<void>, signal: AbortSignal) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "", pending = "", output = "", bytes = 0, complete = false, ended = false;
  const emit = async (text: string, flush = false) => {
    pending += text;
    if (apiKey && pending.includes(apiKey)) throw new LlmStreamError("LLM_SECRET_ECHO");
    let end = flush ? pending.length : Math.max(0, pending.length - Math.max(0, apiKey.length - 1));
    if (end && /[\ud800-\udbff]/u.test(pending[end - 1]!)) { if (flush) throw new LlmStreamError("LLM_INVALID_RESPONSE"); end -= 1; }
    const ready = pending.slice(0, end);
    pending = pending.slice(end);
    output += ready;
    if (output.length + pending.length > 64_000) throw new LlmStreamError("LLM_RESPONSE_TOO_LARGE");
    if (ready) await onText(ready);
  };
  const line = async (value: string) => {
    if (!value.startsWith("data:")) return;
    const data = value.slice(5).trim();
    if (!data) return;
    if (data === "[DONE]") { complete = true; ended = true; return; }
    let payload: { error?: unknown; choices?: Array<{ delta?: { content?: unknown }; finish_reason?: unknown }> };
    try { payload = JSON.parse(data); } catch { throw new LlmStreamError("LLM_INVALID_RESPONSE"); }
    if (payload.error) throw new LlmStreamError("LLM_HTTP_ERROR");
    const choice = payload.choices?.[0];
    if (choice?.finish_reason === "length") throw new LlmStreamError("LLM_RESPONSE_TOO_LARGE");
    if (typeof choice?.delta?.content === "string") await emit(choice.delta.content);
    if (choice?.finish_reason && choice.finish_reason !== "stop") throw new LlmStreamError("LLM_INVALID_RESPONSE");
    if (choice?.finish_reason === "stop") complete = true;
  };
  for await (const chunk of chunks) {
    signal.throwIfAborted();
    bytes += chunk.byteLength;
    if (bytes > 2 * 1024 * 1024) throw new LlmStreamError("LLM_RESPONSE_TOO_LARGE");
    buffer += decoder.decode(chunk, { stream: true });
    let end: number;
    while (!ended && (end = buffer.indexOf("\n")) >= 0) { await line(buffer.slice(0, end).replace(/\r$/u, "")); buffer = buffer.slice(end + 1); }
    if (ended) { buffer = ""; break; }
    if (buffer.length > 64_000) throw new LlmStreamError("LLM_RESPONSE_TOO_LARGE");
  }
  buffer += decoder.decode();
  if (buffer.trim()) await line(buffer);
  if (!complete) throw new LlmStreamError("LLM_INVALID_RESPONSE");
  signal.throwIfAborted();
  await emit("", true);
  if (!output.trim()) throw new LlmStreamError("LLM_INVALID_RESPONSE");
  return output;
}

export async function* readableChunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try { while (true) { const next = await reader.read(); if (next.done) return; yield next.value; } }
  finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
