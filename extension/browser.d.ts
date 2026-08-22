interface ZhiyeClipResult {
  title: string;
  sourceUrl: string;
  author: string | null;
  publishedAt: string | null;
  markdown: string;
}

interface Window {
  __ZHIYE_CLIP_RESULT__?: Promise<ZhiyeClipResult>;
}

declare const chrome: {
  runtime: { lastError?: { message?: string } };
  storage: { local: {
    get(keys: string[]): Promise<Record<string, unknown>>;
    set(values: Record<string, unknown>): Promise<void>;
    remove(keys: string[]): Promise<void>;
  } };
  tabs: { query(queryInfo: { active?: boolean; currentWindow?: boolean; url?: string | string[] }): Promise<Array<{ id?: number; url?: string }>> };
  scripting: { executeScript<T, Args extends unknown[] = []>(details: {
    target: { tabId: number };
    files?: string[];
    func?: (...args: Args) => T | Promise<T>;
    args?: Args;
  }): Promise<Array<{ result?: T }>> };
};

declare const browser: typeof chrome;
