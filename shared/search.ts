export function searchTerms(query: string) {
  return [...new Set(query.trim().split(/\s+/u).filter(Boolean))];
}

export function escapeLike(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

export function paperTextMatch(match: (field: string) => string) {
  return `EXISTS (SELECT 1 FROM json_each(pp.original_json) block WHERE ${match("COALESCE(json_extract(block.value, '$.original'), '')")}) OR
    EXISTS (SELECT 1 FROM json_each(pp.translation_json) block WHERE ${match("COALESCE(json_extract(block.value, '$.translation'), '')")})`;
}

// SQL returns a window around the earliest literal match, rather than transferring entire bodies.
export function searchExcerptSql(field: string, caseSensitive: boolean) {
  const text = caseSensitive ? field : `lower(${field})`;
  const term = caseSensitive ? "search_context.value" : "lower(search_context.value)";
  return `substr(${field}, MAX(1, COALESCE((SELECT MIN(NULLIF(instr(${text}, ${term}), 0)) FROM json_each(?) search_context), 1) - 60), 1200)`;
}

export function paperPageTextSql(key: "original" | "translation") {
  return `COALESCE((SELECT group_concat(COALESCE(json_extract(block.value, '$.${key}'), ''), char(10)) FROM json_each(pp.${key}_json) block), '')`;
}

// Keep excerpts bounded and plain text; the UI renders and highlights them itself.
export function searchMatches(texts: string[], query: string, caseSensitive = false): string[] {
  const terms = searchTerms(query).map((term) => caseSensitive ? term : term.toLowerCase());
  const matches: string[] = [];
  for (const text of texts) {
    const searchable = caseSensitive ? text : text.toLowerCase();
    let cursor = 0;
    while (cursor < text.length && matches.length < 5) {
      const positions = terms.map((term) => searchable.indexOf(term, cursor)).filter((position) => position >= 0);
      if (!positions.length) break;
      const position = Math.min(...positions);
      const start = Math.max(0, position - 60);
      const end = Math.min(text.length, start + 240);
      matches.push(`${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`);
      cursor = end;
    }
    if (matches.length === 5) break;
  }
  return [...new Set(matches)];
}
