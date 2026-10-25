import { layoutNetwork3D } from "./graph-layout-3d";
import type { NetworkLayoutInput } from "./graph-layout-3d";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<{ requestId: number; data: NetworkLayoutInput }>) => void) | null;
  postMessage(value: unknown, transfer?: Transferable[]): void;
};
scope.onmessage = ({ data }) => {
  try {
    const result = layoutNetwork3D(data.data);
    scope.postMessage({ requestId: data.requestId, ...result }, [result.positions.buffer]);
  } catch {
    scope.postMessage({ requestId: data.requestId, error: true });
  }
};
