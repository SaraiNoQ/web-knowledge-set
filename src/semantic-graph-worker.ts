import { appendSemanticGraphState, createSemanticGraphState, semanticVectorKey } from "../shared/semantic-graph.js";
import type { SemanticGraphResult } from "../shared/semantic-graph.js";
import type { SemanticGraphState } from "../shared/semantic-graph.js";
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
let state: SemanticGraphState | null = null;

scope.onmessage = ({ data }) => {
  try {
    if (data.mode === "reset") {
      state = null;
      scope.postMessage({ requestId: data.requestId, graphKey: "", result: { edges: [], neighbors: {} } });
      return;
    }
    if (data.mode === "replace") {
      state = createSemanticGraphState(data.vectors);
    } else {
      if (!state || semanticVectorKey(state.entries) !== data.baseKey) {
        scope.postMessage({ requestId: data.requestId, error: "SEMANTIC_GRAPH_BASE_MISMATCH" });
        return;
      }
      state = appendSemanticGraphState(state, data.vectors);
    }
    scope.postMessage({ requestId: data.requestId, graphKey: semanticVectorKey(state!.entries), result: state!.graph });
  } catch {
    scope.postMessage({ requestId: data.requestId, error: "SEMANTIC_GRAPH_INVALID" });
  }
};

export {};
