import { computeSemanticGraph, extendSemanticGraph, semanticVectorKey } from "../shared/semantic-graph.js";
import type { SemanticGraphResult } from "../shared/semantic-graph.js";
import type { SemanticVectorEntry } from "../shared/types.js";

type WorkerRequest =
  | { requestId: number; mode: "reset" }
  | { requestId: number; mode: "replace"; vectors: SemanticVectorEntry[] }
  | { requestId: number; mode: "append"; baseKey: string; vectors: SemanticVectorEntry[] };
interface WorkerResponse { requestId: number; graphKey?: string; result?: SemanticGraphResult; error?: string; }

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse): void;
};
let vectors: SemanticVectorEntry[] = [];
let graph: SemanticGraphResult = { edges: [], neighbors: {} };

scope.onmessage = ({ data }) => {
  try {
    if (data.mode === "reset") {
      vectors = [];
      graph = { edges: [], neighbors: {} };
      scope.postMessage({ requestId: data.requestId, graphKey: "", result: graph });
      return;
    }
    if (data.mode === "replace") {
      vectors = data.vectors;
      graph = computeSemanticGraph(vectors);
    } else {
      if (semanticVectorKey(vectors) !== data.baseKey) {
        scope.postMessage({ requestId: data.requestId, error: "SEMANTIC_GRAPH_BASE_MISMATCH" });
        return;
      }
      const next = [...vectors, ...data.vectors];
      graph = extendSemanticGraph(vectors, graph, next) ?? computeSemanticGraph(next);
      vectors = next;
    }
    scope.postMessage({ requestId: data.requestId, graphKey: semanticVectorKey(vectors), result: graph });
  } catch {
    scope.postMessage({ requestId: data.requestId, error: "SEMANTIC_GRAPH_INVALID" });
  }
};

export {};
