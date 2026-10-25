export class TranslationCache {
  private entries = new Map<string, { text: string; expiresAt: number; bytes: number }>();
  private used = 0;
  constructor(private readonly maxEntries = 32, private readonly maxBytes = 512 * 1024, private readonly ttlMs = 5 * 60_000, private readonly now = Date.now) {
    if (![maxEntries, maxBytes, ttlMs].every((value) => Number.isSafeInteger(value) && value > 0)) throw new TypeError("Invalid translation cache budget");
  }
  private remove(key: string) { const item = this.entries.get(key); if (item) { this.used -= item.bytes; this.entries.delete(key); } }
  get(key: string) {
    const item = this.entries.get(key);
    if (!item) return null;
    if (item.expiresAt <= this.now()) { this.remove(key); return null; }
    this.entries.delete(key); this.entries.set(key, item);
    return item.text;
  }
  set(key: string, text: string) {
    this.remove(key);
    const bytes = new TextEncoder().encode(key + text).byteLength;
    if (!text.trim() || bytes > this.maxBytes) return;
    for (const [id, item] of this.entries) if (item.expiresAt <= this.now()) this.remove(id);
    while (this.entries.size >= this.maxEntries || this.used + bytes > this.maxBytes) this.remove(this.entries.keys().next().value!);
    this.entries.set(key, { text, expiresAt: this.now() + this.ttlMs, bytes }); this.used += bytes;
  }
  clear() { this.entries.clear(); this.used = 0; }
}
