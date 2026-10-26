import type { DocumentFilters, DocumentListResponse } from "../shared/types";
import { documentListUrl } from "./document-list-url";
import { userErrorMessage } from "./error-messages";

export type DirectoryLoad = { key: string; requestId: number; filters: DocumentFilters; epoch: string | null; page: number };
export type DirectoryResult = { key: string; requestId: number; result?: DocumentListResponse; error?: string; done: boolean };
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<DirectoryLoad | { cancel: string }>) => void) | null;
  postMessage(value: DirectoryResult): void;
};
const tasks = new Map<string, AbortController>();
scope.onmessage = ({ data }) => {
  const key = "cancel" in data ? data.cancel : data.key;
  tasks.get(key)?.abort();
  tasks.delete(key);
  if ("cancel" in data) return;
  const controller = new AbortController();
  tasks.set(key, controller);
  void (async () => {
    try {
      for (let page = data.page; !controller.signal.aborted; page++) {
        const response = await fetch(documentListUrl({ ...data.filters, page }), { signal: controller.signal, credentials: "same-origin", headers: { Accept: "application/json" } });
        if (data.epoch && response.headers.get("X-Zhiye-Data-Epoch") !== data.epoch) throw new Error("知识库已从备份恢复，请刷新后继续。");
        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          throw new Error(userErrorMessage(payload?.error?.code || "REQUEST_FAILED", response.status));
        }
        const result = await response.json() as DocumentListResponse;
        const done = !result.items.length || result.page * result.pageSize >= result.total;
        if (controller.signal.aborted) return;
        scope.postMessage({ key, requestId: data.requestId, result, done });
        if (done) return;
        // Give the UI time to commit each small batch instead of flooding its message queue.
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } catch (error) {
      if (!controller.signal.aborted) scope.postMessage({ key, requestId: data.requestId, error: error instanceof Error ? error.message : "目录加载失败，请重试。", done: true });
    } finally {
      if (tasks.get(key) === controller) tasks.delete(key);
    }
  })();
};
