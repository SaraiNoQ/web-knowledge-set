import assert from "node:assert/strict";
import test from "node:test";
import type { HomePage } from "../shared/home.js";
import { HomeShelfCache } from "../src/home-cache.js";

const page = (revision = 1): HomePage => ({ revision, items: [], total: 0, libraryTotal: 1, folders: [], page: 1 });

test("home pages expire after one minute, retain readable data on invalidation, and are App scoped", async () => {
  let now = 0;
  const cache = new HomeShelfCache(() => now);
  cache.sync("library-a", 0);
  const data = page();
  await cache.load("", 1, async () => data);
  assert.deepEqual(cache.get("", 1, "library-a", 0), { data, fresh: true });
  now = 60_000;
  assert.equal(cache.get("", 1, "library-a", 0)?.fresh, false);
  cache.sync("library-a", 1);
  assert.deepEqual(cache.get("", 1, "library-a", 1), { data, fresh: false });
  assert.equal(new HomeShelfCache().get("", 1, "library-a", 0), null);
});

test("home requests coalesce and invalidated requests cannot overwrite a newer page", async () => {
  const cache = new HomeShelfCache();
  cache.sync("library-a", 0);
  let finish!: (value: HomePage) => void;
  const old = cache.load("", 1, () => new Promise(resolve => { finish = resolve; }));
  const oldResult = assert.rejects(old, { name: "AbortError" });
  assert.equal(cache.load("", 1, async () => { throw new Error("Duplicate request"); }), old);
  cache.sync("library-a", 1);
  const current = page(2);
  await cache.load("", 1, async () => current);
  finish(page(1));
  await oldResult;
  assert.equal(cache.get("", 1, "library-a", 1)?.data, current);
});

test("an editor's newer revision marks cached pages stale without removing readable cards", async () => {
  const cache = new HomeShelfCache();
  cache.sync("library-a", 0);
  const data = page(1);
  await cache.load("", 1, async () => data);
  cache.observeRevision(1);
  assert.deepEqual(cache.get("", 1, "library-a", 0), { data, fresh: true });
  cache.observeRevision(2);
  assert.deepEqual(cache.get("", 1, "library-a", 0), { data, fresh: false });
});

test("a restored library clears pages and cancels requests from the old epoch", async () => {
  const cache = new HomeShelfCache();
  cache.sync("before-restore", 0);
  await cache.load("", 1, async () => page());
  let finish!: (value: HomePage) => void;
  const pending = cache.load("folder", 1, () => new Promise(resolve => { finish = resolve; }));
  const rejected = assert.rejects(pending, { name: "AbortError" });
  assert.equal(cache.get("", 1, "after-restore", 0), null);
  let cleared = 0;
  const unsubscribe = cache.subscribe(() => cleared++);
  cache.sync("after-restore", 0);
  finish(page()); await rejected;
  assert.equal(cache.get("", 1, "after-restore", 0), null);
  assert.equal(cleared, 1); unsubscribe();
});

test("authentication and stale epoch errors remove old cards; temporary failures preserve them", async () => {
  for (const error of [{ status: 401 }, { status: 403 }, { status: 409, code: "STALE_DATA_EPOCH" }, { status: 503 }]) {
    const cache = new HomeShelfCache();
    cache.sync("library-a", 0);
    const data = page();
    await cache.load("", 1, async () => data);
    cache.invalidate();
    let notified: unknown;
    cache.subscribe(cause => { notified = cause; });
    await assert.rejects(cache.load("", 1, async () => { throw error; }));
    assert.equal(cache.get("", 1, "library-a", 0)?.data ?? null, error.status === 503 ? data : null);
    assert.equal(notified, error.status === 503 ? undefined : error);
  }
});

test("the home cache evicts least recently used pages at its twelve-page limit", async () => {
  const cache = new HomeShelfCache();
  cache.sync("library-a", 0);
  for (let i = 1; i <= 12; i++) await cache.load("", i, async () => page(i));
  cache.get("", 1, "library-a", 0);
  await cache.load("", 13, async () => page(13));
  assert.equal(cache.get("", 2, "library-a", 0), null);
  assert.equal(cache.get("", 1, "library-a", 0)?.data.revision, 1);
  assert.equal(cache.get("", 13, "library-a", 0)?.data.revision, 13);
});
