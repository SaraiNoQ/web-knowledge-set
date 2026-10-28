import assert from 'node:assert/strict';
import test from 'node:test';
import { cronEntry, mergeWorkerCron } from '../scripts/configure-tweet-video-worker.mjs';
test('video background schedule is idempotent and preserves unrelated user jobs', () => {
  const entry = cronEntry('/opt/node/bin/node', '/srv/worker/server/tweet-video-worker.js', '/srv/worker/config.json');
  const first = mergeWorkerCron('5 0 * * * /usr/bin/true\n', entry);
  assert.equal(mergeWorkerCron(first, entry), first);
  assert.match(first, /^5 0 \* \* \* \/usr\/bin\/true\n/u);
  assert.equal(first.split('# zhiye-tweet-video-worker').length, 2);
  assert.throws(() => cronEntry('/tmp/a;uname', '/srv/worker.js', '/srv/config.json'));
});
