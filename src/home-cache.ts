import type { HomePage } from "../shared/home";

const FRESH_MS = 60_000;
const MAX_PAGES = 12;
interface Entry { data?: HomePage; freshUntil: number; request?: Promise<HomePage>; controller?: AbortController }

// Scoped to one App instance; never persist a reader's library in browser storage.
export class HomeShelfCache {
  private pages = new Map<string, Entry>();
  private epoch: string | null = null;
  private revision = 0;
  private generation = 0;
  private listeners = new Set<(cause?: unknown) => void>();
  constructor(private readonly now = Date.now) {}

  sync(epoch: string | null, revision: number) {
    this.syncEpoch(epoch);
    if (this.revision !== revision) { this.invalidate(); this.revision = revision; }
  }

  syncEpoch(epoch: string | null) {
    if (this.epoch !== null && epoch !== this.epoch) this.clear();
    this.epoch = epoch;
  }

  get(folder: string, page: number, epoch: string | null, revision: number) {
    if (this.epoch !== null && epoch !== this.epoch) return null;
    const key = JSON.stringify([folder, page]), entry = this.pages.get(key);
    if (!entry?.data) return null;
    this.pages.delete(key); this.pages.set(key, entry);
    return { data: entry.data, fresh: this.revision === revision && entry.freshUntil > this.now() };
  }

  load(folder: string, page: number, fetchPage: (signal: AbortSignal) => Promise<HomePage>) {
    const key = JSON.stringify([folder, page]);
    let entry = this.pages.get(key);
    if (entry?.request) return entry.request;
    if (!entry) {
      entry = { freshUntil: 0 };
      while (this.pages.size >= MAX_PAGES) {
        const oldest = this.pages.keys().next().value!;
        this.pages.get(oldest)?.controller?.abort(); this.pages.delete(oldest);
      }
      this.pages.set(key, entry);
    }
    const current = entry, generation = this.generation, controller = new AbortController();
    current.controller = controller;
    const request: Promise<HomePage> = fetchPage(controller.signal).then(data => {
      controller.signal.throwIfAborted();
      if (generation !== this.generation) throw new DOMException("Home cache changed", "AbortError");
      current.data = data; current.freshUntil = this.now() + FRESH_MS;
      return data;
    }).catch(cause => {
      controller.signal.throwIfAborted();
      this.clearOnError(cause); throw cause;
    }).finally(() => {
      if (current.request === request) { current.request = undefined; current.controller = undefined; }
    });
    current.request = request;
    return request;
  }

  invalidate() {
    this.generation++;
    for (const entry of this.pages.values()) {
      entry.controller?.abort(); entry.controller = undefined; entry.request = undefined; entry.freshUntil = 0;
    }
  }

  observeRevision(revision: number) {
    for (const { data } of this.pages.values()) {
      if (data && data.revision !== revision) { this.invalidate(); return; }
    }
  }

  clear(cause?: unknown) {
    this.invalidate(); this.pages.clear();
    for (const listener of this.listeners) listener(cause);
  }

  clearOnError(cause: unknown) {
    const error = cause as { status?: number; code?: string } | null;
    if (error && (error.status === 401 || error.status === 403 || error.code === "STALE_DATA_EPOCH")) {
      this.clear(cause); return true;
    }
    return false;
  }

  subscribe(listener: (cause?: unknown) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}
