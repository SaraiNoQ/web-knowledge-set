import type { SemanticVectorEntry } from "./types.js";

export const SEMANTIC_GRAPH_MAX_NODES = 1_000;
export const SEMANTIC_GRAPH_NEIGHBORS = 10;
const MUTUAL_NEIGHBORS = 5;

export interface SemanticGraphEdge {
  source: string;
  target: string;
  score: number;
}

export interface SemanticGraphNeighbor {
  id: string;
  score: number;
}

export interface SemanticGraphResult {
  edges: SemanticGraphEdge[];
  neighbors: Record<string, SemanticGraphNeighbor[]>;
}

interface Candidate {
  index: number;
  score: number;
}

export function semanticVectorKey(entries: Array<Pick<SemanticVectorEntry, "id" | "sourceHash" | "model" | "formatVersion"> | {
  id: string; sourceHash: string | null; model: string | null; formatVersion: string | null;
}>) {
  return JSON.stringify(entries.map(({ id, sourceHash, model, formatVersion }) => [id, sourceHash, model, formatVersion] as const)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}

function compareIds(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function keepTop(list: Candidate[], candidate: Candidate, entries: SemanticVectorEntry[], limit: number) {
  let position = 0;
  while (position < list.length) {
    const current = list[position]!;
    if (candidate.score > current.score ||
      (candidate.score === current.score && compareIds(entries[candidate.index]!.id, entries[current.index]!.id) < 0)) break;
    position += 1;
  }
  if (position >= limit) return;
  list.splice(position, 0, candidate);
  if (list.length > limit) list.pop();
}

function normalizeEntries(input: SemanticVectorEntry[]) {
  if (input.length > SEMANTIC_GRAPH_MAX_NODES) throw new RangeError("Semantic graph is limited to 1,000 filtered nodes");
  const entries = [...input].sort((left, right) => compareIds(left.id, right.id));
  if (new Set(entries.map(({ id }) => id)).size !== entries.length) throw new TypeError("Semantic graph node ids must be unique");
  if (!entries.length) return { entries, normalized: [] as Float32Array[] };

  const first = entries[0]!;
  const dimension = first.vector.length;
  if (!dimension || dimension > 4_096) throw new TypeError("Semantic graph vector dimension is invalid");
  const normalized = entries.map((entry) => {
    if (entry.model !== first.model || entry.formatVersion !== first.formatVersion || entry.vector.length !== dimension ||
      entry.vector.some((value) => !Number.isFinite(value))) throw new TypeError("Semantic graph vectors are incompatible");
    const magnitude = Math.sqrt(entry.vector.reduce((sum, value) => sum + value * value, 0));
    if (!Number.isFinite(magnitude) || magnitude === 0) throw new TypeError("Semantic graph vector norm is invalid");
    return Float32Array.from(entry.vector, (value) => value / magnitude);
  });
  return { entries, normalized };
}

function score(left: Float32Array, right: Float32Array) {
  let result = 0;
  for (let axis = 0; axis < left.length; axis += 1) result += left[axis]! * right[axis]!;
  return Math.max(-1, Math.min(1, result));
}

function resultFromTop(entries: SemanticVectorEntry[], top: Candidate[][]): SemanticGraphResult {
  const topFive = top.map((items) => new Set(items.slice(0, MUTUAL_NEIGHBORS).map(({ index }) => index)));
  const edges: SemanticGraphEdge[] = [];
  for (let source = 0; source < entries.length; source += 1) {
    for (const candidate of top[source]!.slice(0, MUTUAL_NEIGHBORS)) {
      if (candidate.index <= source || !topFive[candidate.index]!.has(source)) continue;
      edges.push({ source: entries[source]!.id, target: entries[candidate.index]!.id, score: candidate.score });
    }
  }
  const neighbors = Object.fromEntries(entries.map((entry, index) => [
    entry.id,
    top[index]!.map(({ index: neighbor, score: value }) => ({ id: entries[neighbor]!.id, score: value })),
  ]));
  return { edges, neighbors };
}

export function computeSemanticGraph(input: SemanticVectorEntry[]): SemanticGraphResult {
  const { entries, normalized } = normalizeEntries(input);
  if (!entries.length) return { edges: [], neighbors: {} };
  const top = Array.from({ length: entries.length }, () => [] as Candidate[]);
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      const value = score(normalized[left]!, normalized[right]!);
      keepTop(top[left]!, { index: right, score: value }, entries, SEMANTIC_GRAPH_NEIGHBORS);
      keepTop(top[right]!, { index: left, score: value }, entries, SEMANTIC_GRAPH_NEIGHBORS);
    }
  }
  return resultFromTop(entries, top);
}

export function extendSemanticGraph(previousInput: SemanticVectorEntry[], previousGraph: SemanticGraphResult, input: SemanticVectorEntry[]) {
  const { entries, normalized } = normalizeEntries(input);
  const previous = [...previousInput].sort((left, right) => compareIds(left.id, right.id));
  if (!previous.length || entries.length <= previous.length) return null;

  const currentIndex = new Map(entries.map((entry, index) => [entry.id, index]));
  const previousIds = new Set<string>();
  for (const old of previous) {
    const index = currentIndex.get(old.id);
    const current = index === undefined ? undefined : entries[index];
    if (!current || previousIds.has(old.id) || old.model !== current.model || old.formatVersion !== current.formatVersion ||
      old.sourceHash !== current.sourceHash || old.vector.length !== current.vector.length ||
      old.vector.some((value, axis) => value !== current.vector[axis])) return null;
    previousIds.add(old.id);
  }

  const added = new Set(entries.map((entry, index) => previousIds.has(entry.id) ? -1 : index).filter((index) => index >= 0));
  if (!added.size) return null;
  const top = Array.from({ length: entries.length }, () => [] as Candidate[]);
  for (const old of previous) {
    const oldIndex = currentIndex.get(old.id)!;
    const neighbors = previousGraph.neighbors[old.id];
    if (!Array.isArray(neighbors) || neighbors.length !== Math.min(SEMANTIC_GRAPH_NEIGHBORS, previous.length - 1)) return null;
    const seen = new Set<string>();
    for (const neighbor of neighbors) {
      const index = currentIndex.get(neighbor.id);
      if (index === undefined || index === oldIndex || seen.has(neighbor.id) || !Number.isFinite(neighbor.score)) return null;
      seen.add(neighbor.id);
      keepTop(top[oldIndex]!, { index, score: neighbor.score }, entries, SEMANTIC_GRAPH_NEIGHBORS);
    }
  }

  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      if (!added.has(left) && !added.has(right)) continue;
      const value = score(normalized[left]!, normalized[right]!);
      keepTop(top[left]!, { index: right, score: value }, entries, SEMANTIC_GRAPH_NEIGHBORS);
      keepTop(top[right]!, { index: left, score: value }, entries, SEMANTIC_GRAPH_NEIGHBORS);
    }
  }
  return resultFromTop(entries, top);
}
