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

export interface SemanticGraphState {
  entries: SemanticVectorEntry[];
  normalized: Map<string, Float32Array>;
  graph: SemanticGraphResult;
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

function buildGraphState(input: SemanticVectorEntry[]): SemanticGraphState {
  const { entries, normalized } = normalizeEntries(input);
  if (!entries.length) return { entries, normalized: new Map(), graph: { edges: [], neighbors: {} } };
  const top = Array.from({ length: entries.length }, () => [] as Candidate[]);
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      const value = score(normalized[left]!, normalized[right]!);
      keepTop(top[left]!, { index: right, score: value }, entries, SEMANTIC_GRAPH_NEIGHBORS);
      keepTop(top[right]!, { index: left, score: value }, entries, SEMANTIC_GRAPH_NEIGHBORS);
    }
  }
  return {
    entries,
    normalized: new Map(entries.map((entry, index) => [entry.id, normalized[index]!])),
    graph: resultFromTop(entries, top),
  };
}

export function createSemanticGraphState(input: SemanticVectorEntry[]) {
  return buildGraphState(input);
}

export function computeSemanticGraph(input: SemanticVectorEntry[]): SemanticGraphResult {
  return buildGraphState(input).graph;
}

export function appendSemanticGraphState(state: SemanticGraphState, additionsInput: SemanticVectorEntry[]): SemanticGraphState {
  if (!additionsInput.length) return state;
  if (state.entries.length + additionsInput.length > SEMANTIC_GRAPH_MAX_NODES) {
    throw new RangeError("Semantic graph is limited to 1,000 filtered nodes");
  }
  const additions = [...additionsInput].sort((left, right) => compareIds(left.id, right.id));
  const first = state.entries[0] ?? additions[0]!;
  const dimension = first.vector.length;
  if (!dimension || dimension > 4_096) throw new TypeError("Semantic graph vector dimension is invalid");
  const knownIds = new Set(state.entries.map(({ id }) => id));
  const normalizedAdded = new Map<string, Float32Array>();
  for (const entry of additions) {
    if (knownIds.has(entry.id) || entry.model !== first.model || entry.formatVersion !== first.formatVersion ||
      entry.vector.length !== dimension || entry.vector.some((value) => !Number.isFinite(value))) {
      throw new TypeError("Semantic graph vectors are incompatible");
    }
    knownIds.add(entry.id);
    const magnitude = Math.sqrt(entry.vector.reduce((sum, value) => sum + value * value, 0));
    if (!Number.isFinite(magnitude) || magnitude === 0) throw new TypeError("Semantic graph vector norm is invalid");
    normalizedAdded.set(entry.id, Float32Array.from(entry.vector, (value) => value / magnitude));
  }

  const entries = [...state.entries, ...additions].sort((left, right) => compareIds(left.id, right.id));
  const indexById = new Map(entries.map((entry, index) => [entry.id, index]));
  const normalized = new Map(state.normalized);
  for (const [id, vector] of normalizedAdded) normalized.set(id, vector);
  const top = Array.from({ length: entries.length }, () => [] as Candidate[]);
  for (const old of state.entries) {
    const oldIndex = indexById.get(old.id)!;
    const neighbors = state.graph.neighbors[old.id];
    if (!Array.isArray(neighbors) || neighbors.length !== Math.min(SEMANTIC_GRAPH_NEIGHBORS, state.entries.length - 1)) {
      throw new TypeError("Semantic graph state is invalid");
    }
    for (const neighbor of neighbors) {
      const index = indexById.get(neighbor.id);
      if (index === undefined || index === oldIndex || !Number.isFinite(neighbor.score)) throw new TypeError("Semantic graph state is invalid");
      keepTop(top[oldIndex]!, { index, score: neighbor.score }, entries, SEMANTIC_GRAPH_NEIGHBORS);
    }
  }

  const addedIds = new Set(additions.map(({ id }) => id));
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      if (!addedIds.has(entries[left]!.id) && !addedIds.has(entries[right]!.id)) continue;
      const value = score(normalized.get(entries[left]!.id)!, normalized.get(entries[right]!.id)!);
      keepTop(top[left]!, { index: right, score: value }, entries, SEMANTIC_GRAPH_NEIGHBORS);
      keepTop(top[right]!, { index: left, score: value }, entries, SEMANTIC_GRAPH_NEIGHBORS);
    }
  }
  return { entries, normalized, graph: resultFromTop(entries, top) };
}

export function extendSemanticGraph(previousInput: SemanticVectorEntry[], previousGraph: SemanticGraphResult, input: SemanticVectorEntry[]) {
  const { entries } = normalizeEntries(input);
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
  const additions = entries.filter((entry, index) => added.has(index));
  const state = createSemanticGraphState(previous);
  return appendSemanticGraphState({ ...state, graph: previousGraph }, additions).graph;
}
