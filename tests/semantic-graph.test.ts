import assert from "node:assert/strict";
import test from "node:test";

import { computeSemanticGraph, extendSemanticGraph, SEMANTIC_GRAPH_NEIGHBORS, semanticVectorKey } from "../shared/semantic-graph.js";
import type { SemanticVectorEntry } from "../shared/types.js";

function vector(id: string, value: number[], model = "BAAI/bge-m3"): SemanticVectorEntry {
  return { id, sourceHash: id.padStart(64, "0"), model, formatVersion: "semantic-text-v1", vector: value };
}

test("semantic graph normalizes vectors, sorts ties stably, and keeps only mutual top-five edges", () => {
  const entries = [
    vector("a", [10, 0]),
    vector("b", [9.9, 1]),
    vector("c", [9.8, 2]),
    vector("d", [9.7, 3]),
    vector("e", [9.6, 4]),
    vector("f", [9.5, 5]),
    vector("z", [-10, 0]),
  ];
  const result = computeSemanticGraph(entries);
  assert.deepEqual(computeSemanticGraph([...entries].reverse()), result);
  assert.ok(result.neighbors.a!.length <= SEMANTIC_GRAPH_NEIGHBORS);
  assert.equal(result.neighbors.a![0]?.id, "b");
  assert.ok(result.edges.every(({ source, target }) => source !== target && source !== "z" && target !== "z"));
  const ids = result.edges.map(({ source, target }) => [source, target].sort().join(":"));
  assert.equal(new Set(ids).size, ids.length);
  const normalized = computeSemanticGraph([vector("x", [2, 0]), vector("y", [5, 5])]);
  assert.ok(Math.abs(normalized.edges[0]!.score - 1 / Math.sqrt(2)) < 1e-6);
  assert.equal(normalized.neighbors.x?.[0]?.id, "y");
});

test("semantic graph rejects mixed models, dimensions, and duplicate ids", () => {
  assert.throws(() => computeSemanticGraph([vector("a", [1, 0]), vector("b", [0, 1], "other")]));
  assert.throws(() => computeSemanticGraph([vector("a", [1, 0]), vector("b", [0, 1, 1])]));
  assert.throws(() => computeSemanticGraph([vector("same", [1]), vector("same", [2])]));
});

test("incremental graph additions match a full graph and version keys isolate models", () => {
  const entries = [
    vector("a", [1, 0, 0]), vector("b", [.8, .6, 0]), vector("c", [0, 1, 0]),
    vector("d", [0, 0, 1]), vector("e", [.4, .5, .7]),
  ];
  let indexed = entries.slice(0, 2);
  let result = computeSemanticGraph(indexed);
  for (const next of entries.slice(2)) {
    const expanded = [...indexed, next];
    result = extendSemanticGraph(indexed, result, expanded)!;
    assert.deepEqual(result, computeSemanticGraph(expanded));
    indexed = expanded;
  }

  assert.equal(extendSemanticGraph(entries.slice(0, 2), computeSemanticGraph(entries.slice(0, 2)), [
    { ...entries[0]!, sourceHash: "f".repeat(64) }, entries[1]!, entries[2]!,
  ]), null);
  assert.notEqual(semanticVectorKey([entries[0]!]), semanticVectorKey([{ ...entries[0]!, model: "other-model" }]));
  assert.notEqual(semanticVectorKey([entries[0]!]), semanticVectorKey([{ ...entries[0]!, formatVersion: "future" }]));

  const crowded = [
    vector("anchor", [1, 0]),
    ...Array.from({ length: 11 }, (_, index) => {
      const angle = (index + 1) / 100;
      return vector("old-" + String(index).padStart(2, "0"), [Math.cos(angle), Math.sin(angle)]);
    }),
  ];
  const newcomer = vector("new-closest", [Math.cos(.005), Math.sin(.005)]);
  const oldGraph = computeSemanticGraph(crowded);
  assert.equal(oldGraph.neighbors.anchor!.length, SEMANTIC_GRAPH_NEIGHBORS);
  const expanded = extendSemanticGraph(crowded, oldGraph, [...crowded, newcomer]);
  assert.deepEqual(expanded, computeSemanticGraph([...crowded, newcomer]));
  assert.ok(oldGraph.neighbors.anchor!.some(({ id }) => id === "old-09"));
  assert.ok(!expanded!.neighbors.anchor!.some(({ id }) => id === "old-09"));
  assert.ok(expanded!.neighbors.anchor!.some(({ id }) => id === "new-closest"));
});
