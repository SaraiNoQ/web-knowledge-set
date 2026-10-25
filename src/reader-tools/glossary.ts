import { parseTranslationGlossary, type TranslationGlossaryEntry } from "../../shared/reader-tools.js";

export interface TranslationGlossary { revision: number; terms: TranslationGlossaryEntry[] }
export const MAX_GLOSSARY_TERMS = 100;
export const glossarySourceKey = (value: string) => value.normalize("NFKC").toLowerCase();
export function readGlossary(value: unknown): TranslationGlossary {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["revision", "terms"].includes(key))) throw new Error("术语表格式无效，现有术语未被覆盖。");
  const input = value as Record<string, unknown>;
  if (!Number.isSafeInteger(input.revision) || Number(input.revision) < 0) throw new Error("术语表版本无效。");
  return { revision: Number(input.revision), terms: parseTranslationGlossary(input.terms, MAX_GLOSSARY_TERMS) };
}
export function mergeGlossary(existing: TranslationGlossary, additions: unknown): TranslationGlossary {
  const terms = parseTranslationGlossary(additions, MAX_GLOSSARY_TERMS), merged = new Map(existing.terms.map((term) => [glossarySourceKey(term.source), term]));
  for (const term of terms) {
    const key = glossarySourceKey(term.source), old = merged.get(key);
    if (old && old.target !== term.target) throw new Error(`「${term.source}」已有不同译法，请先处理该词条。现有术语未改动。`);
    merged.set(key, old ?? term);
  }
  if (merged.size > MAX_GLOSSARY_TERMS) throw new Error(`术语表最多保存 ${MAX_GLOSSARY_TERMS} 条，请先导出整理。`);
  if (merged.size === existing.terms.length) return existing;
  return { revision: existing.revision + 1, terms: [...merged.values()] };
}
export function importGlossary(text: string, existing: TranslationGlossary) {
  if (new TextEncoder().encode(text).byteLength > 64 * 1024) throw new Error("术语文件超过 64 KiB。");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("术语文件不是有效 JSON。"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("术语文件格式无效。");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 3 || Object.keys(input).some((key) => !["format", "schemaVersion", "terms"].includes(key)) || input.format !== "zhiye-glossary" || input.schemaVersion !== 1) throw new Error("不支持此术语文件版本，现有术语未被覆盖。");
  return mergeGlossary(existing, input.terms);
}
export function exportGlossary(value: TranslationGlossary) { return JSON.stringify({ format: "zhiye-glossary", schemaVersion: 1, terms: value.terms }, null, 2); }
export function applicableGlossary(value: TranslationGlossary, text: string) {
  const normalized = glossarySourceKey(text);
  return value.terms.filter((term) => normalized.includes(glossarySourceKey(term.source)))
    .sort((a, b) => b.source.length - a.source.length || a.source.localeCompare(b.source)).slice(0, 20);
}
