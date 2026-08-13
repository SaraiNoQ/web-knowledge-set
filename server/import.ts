import { basename } from "node:path";

import type { ImportKind } from "../shared/types.js";
import type { PreparedImportItem } from "./db.js";

const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
const MAX_URLS = 1_000;
const MAX_MARKDOWN_FILES = 100;
const exportedFields = new Set([
  "title", "source", "final_url", "canonical_url", "author", "published_at", "captured_at",
  "tags", "collections", "favorite", "archived_at", "source_note",
]);

export class ImportParseError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function normalizedHttpUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 8_192) return null;
  try {
    const url = new URL(value.trim());
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function decodeHtml(value: string) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/giu, (entity, code: string) => {
    if (code === "amp") return "&";
    if (code === "quot") return '"';
    if (code === "apos") return "'";
    if (code === "lt") return "<";
    if (code === "gt") return ">";
    const point = code[1]?.toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
    return Number.isSafeInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
  });
}

function urlItems(kind: "urls" | "bookmarks", content: string): PreparedImportItem[] {
  let values: Array<{ label: string; url: string }>;
  if (kind === "urls") {
    values = content.split(/\r?\n/u).map((url) => ({ label: url.trim(), url: url.trim() })).filter(({ url }) => url);
  } else {
    if (!/<(?:!doctype\s+netscape-bookmark-file-1|dl)\b/iu.test(content)) {
      throw new ImportParseError("INVALID_BOOKMARKS", "The file is not a Netscape bookmarks document");
    }
    values = [...content.matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/giu)].map(
      (match) => ({
        label: decodeHtml(match[3]!.replace(/<[^>]*>/gu, "").trim()) || decodeHtml(match[2]!),
        url: decodeHtml(match[2]!),
      }),
    );
  }
  if (values.length > MAX_URLS) throw new ImportParseError("IMPORT_LIMIT", `At most ${MAX_URLS} URLs may be imported`);
  return values.map(({ label, url }) => {
    const sourceUrl = normalizedHttpUrl(url);
    return {
      label: (label || url).slice(0, 1_000),
      sourceUrl,
      error: sourceUrl ? null : "A valid HTTP or HTTPS URL is required",
      warnings: [],
      payload: { type: "url" as const, url: sourceUrl },
    };
  });
}

function text(value: unknown, field: string, nullable = true, maxLength = 50_000) {
  if (value === null && nullable) return null;
  if (typeof value !== "string" || value.length > maxLength) throw new Error(`${field} must be a string`);
  return value;
}

function stringArray(value: unknown, field: "tags" | "collections") {
  const limit = field === "tags" ? 50 : 100;
  if (!Array.isArray(value) || value.length > limit) {
    throw new Error(`${field} must be an array of strings`);
  }
  const unique = new Map<string, string>();
  for (const item of value) {
    if (typeof item !== "string") throw new Error(`${field} must be an array of strings`);
    const name = item.normalize("NFKC").trim();
    if (!name || name.length > 100) throw new Error(`${field} entries must contain 1 to 100 characters`);
    unique.set(name.toLocaleLowerCase(), name);
  }
  return [...unique.values()];
}

function parseMarkdown(path: string, content: string): PreparedImportItem {
  const fallbackTitle = basename(path).replace(/\.md(?:own)?$/iu, "") || "Imported note";
  const payload: Extract<PreparedImportItem["payload"], { type: "markdown" }> = {
    type: "markdown",
    title: fallbackTitle,
    sourceUrl: null,
    finalUrl: null,
    canonicalUrl: null,
    author: null,
    publishedAt: null,
    capturedAt: null,
    tags: [],
    collections: [],
    favorite: false,
    archivedAt: null,
    sourceNote: "",
    markdown: content,
  };
  const warnings: string[] = [];
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return { label: fallbackTitle, sourceUrl: null, error: null, warnings, payload };
  }
  const normalized = content.replaceAll("\r\n", "\n");
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing < 0) return { label: fallbackTitle, sourceUrl: null, error: "Front matter is not closed", warnings, payload };
  const lines = normalized.slice(4, closing).split("\n");
  const unknown: string[] = [];
  try {
    for (const line of lines) {
      const separator = line.indexOf(":");
      if (separator <= 0) throw new Error("Front matter lines must use key: JSON-value format");
      const key = line.slice(0, separator).trim();
      if (!/^[a-z_]+$/u.test(key)) throw new Error(`Invalid front matter key: ${key}`);
      if (!exportedFields.has(key)) {
        unknown.push(line);
        continue;
      }
      const value: unknown = JSON.parse(line.slice(separator + 1).trim());
      if (key === "title") {
        payload.title = text(value, key, false, 1_000)!.trim();
        if (!payload.title) throw new Error("title must contain 1 to 1000 characters");
      }
      else if (key === "source") {
        if (value !== null && !normalizedHttpUrl(value)) throw new Error("source must be an HTTP or HTTPS URL");
        payload.sourceUrl = value === null ? null : normalizedHttpUrl(value);
      } else if (key === "final_url" || key === "canonical_url") {
        if (value !== null && !normalizedHttpUrl(value)) throw new Error(`${key} must be an HTTP or HTTPS URL`);
        payload[key === "final_url" ? "finalUrl" : "canonicalUrl"] = value === null ? null : normalizedHttpUrl(value);
      } else if (key === "author") payload.author = text(value, key, true, 1_000);
      else if (key === "published_at") payload.publishedAt = text(value, key);
      else if (key === "captured_at") payload.capturedAt = text(value, key);
      else if (key === "tags") payload.tags = stringArray(value, key);
      else if (key === "collections") payload.collections = stringArray(value, key);
      else if (key === "favorite") {
        if (typeof value !== "boolean") throw new Error("favorite must be boolean");
        payload.favorite = value;
      } else if (key === "archived_at") payload.archivedAt = text(value, key);
      else if (key === "source_note") payload.sourceNote = text(value, key, false)!;
    }
    if (payload.publishedAt && (
      !/^\d{4}-\d{2}-\d{2}$/u.test(payload.publishedAt) ||
      new Date(`${payload.publishedAt}T00:00:00.000Z`).toISOString().slice(0, 10) !== payload.publishedAt
    )) {
      throw new Error("published_at must be a YYYY-MM-DD date");
    }
    for (const [field, value] of [["captured_at", payload.capturedAt], ["archived_at", payload.archivedAt]] as const) {
      if (value && !Number.isFinite(Date.parse(value))) throw new Error(`${field} must be an ISO date`);
    }
  } catch (error) {
    return { label: fallbackTitle, sourceUrl: null, error: error instanceof Error ? error.message : "Invalid front matter", warnings, payload };
  }
  if (unknown.length) {
    warnings.push(`Unknown front matter fields were preserved: ${unknown.map((line) => line.slice(0, line.indexOf(":"))).join(", ")}`);
    payload.markdown = `${unknown.length ? `---\n${unknown.join("\n")}\n---\n\n` : ""}${normalized.slice(closing + 5)}`;
  } else {
    payload.markdown = normalized.slice(closing + 5);
  }
  return { label: payload.title, sourceUrl: payload.sourceUrl, error: null, warnings, payload };
}

export function parseImportRequest(kind: ImportKind, input: { content?: unknown; files?: unknown }): PreparedImportItem[] {
  if (kind === "urls" || kind === "bookmarks") {
    if (typeof input.content !== "string") throw new ImportParseError("INVALID_IMPORT", "content must be a string");
    if (Buffer.byteLength(input.content) > MAX_IMPORT_BYTES) throw new ImportParseError("IMPORT_LIMIT", "Import content exceeds 10 MiB");
    return urlItems(kind, input.content);
  }
  if (!Array.isArray(input.files) || input.files.length > MAX_MARKDOWN_FILES) {
    throw new ImportParseError("IMPORT_LIMIT", `files must contain at most ${MAX_MARKDOWN_FILES} Markdown files`);
  }
  let bytes = 0;
  return input.files.map((file) => {
    if (!file || typeof file !== "object" || Array.isArray(file)) {
      throw new ImportParseError("INVALID_IMPORT", "Each Markdown file must contain path and content strings");
    }
    const { path, content } = file as { path?: unknown; content?: unknown };
    if (typeof path !== "string" || !path || path.length > 1_024 || path.includes("\0") || typeof content !== "string") {
      throw new ImportParseError("INVALID_IMPORT", "Each Markdown file must contain a valid path and string content");
    }
    bytes += Buffer.byteLength(content);
    if (bytes > MAX_IMPORT_BYTES) throw new ImportParseError("IMPORT_LIMIT", "Markdown import exceeds 10 MiB");
    if (content.includes("\0") || content.includes("\ufffd")) {
      return {
        label: basename(path), sourceUrl: null, error: "Markdown must be valid UTF-8 text", warnings: [],
        payload: { type: "markdown", title: basename(path), sourceUrl: null, finalUrl: null, canonicalUrl: null,
          author: null, publishedAt: null, capturedAt: null, tags: [], collections: [], favorite: false,
          archivedAt: null, sourceNote: "", markdown: content },
      } satisfies PreparedImportItem;
    }
    return parseMarkdown(path, content);
  });
}
