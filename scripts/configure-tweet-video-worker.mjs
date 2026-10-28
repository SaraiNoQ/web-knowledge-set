import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = '/srv/zhiye-delivery/tweet-video-worker';
const endpoint = 'https://clip.sarainoq.cn/api/browser-extension/video-worker';
export function cronEntry(node, entry, config) {
  for (const value of [node, entry, config]) assert(/^\/[A-Za-z0-9_/@.+-]+$/u.test(value), 'Unsafe worker path');
  return `* * * * * umask 077; /usr/bin/flock -n ${root}/worker.lock ${node} ${entry} --config ${config} >> ${root}/worker.log 2>&1 # zhiye-tweet-video-worker`;
}
export function mergeWorkerCron(existing, entry) {
  const lines = existing.split('\n').filter(line => line && !line.endsWith('# zhiye-tweet-video-worker'));
  return [...lines, entry, ''].join('\n');
}

export async function configureVideoWorker(mode, requestPath, fetcher = fetch) {
  assert(process.getuid?.() !== 0, 'Use the non-root production account');
  const request = JSON.parse(readFileSync(requestPath, 'utf8'));
  assert(/^[a-f0-9]{40}$/u.test(request.sha), 'Invalid source');
  assert(request.cloudflareToken, 'Missing private deployment token');
  const configPath = `${root}/config.json`;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const webConfig = JSON.parse(readFileSync('cloud/wrangler.web.jsonc', 'utf8'));
  const db = webConfig.d1_databases.find(binding => binding.binding === 'DB');
  assert(/^[a-f0-9-]{36}$/u.test(db.database_id));
  const query = async (sql, params = []) => {
    const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${webConfig.account_id}/d1/database/${db.database_id}/query`, {
      method: 'POST', headers: { Authorization: `Bearer ${request.cloudflareToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, params }), redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json();
    assert(response.ok && result.success && result.result?.every(item => item.success), 'Video worker database operation failed');
    return result.result[0]?.results ?? [];
  };
  if (mode === 'prepare') {
    // Inspect availability before publishing; never replace other user cron jobs.
    let cron = '';
    try { cron = execFileSync('crontab', ['-l'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) { assert(error.status === 1 && /no crontab/i.test(String(error.stderr)), 'User crontab is unavailable'); }
    assert.equal(typeof cron, 'string');
    const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {
      endpoint, token: randomBytes(32).toString('base64url'), temporaryDirectory: `${root}/tmp`,
    };
    assert(config.endpoint === endpoint && /^[A-Za-z0-9_-]{43}$/u.test(config.token));
    assert(config.temporaryDirectory === `${root}/tmp`);
    await query("INSERT INTO app_settings(key,value,revision,updated_at) VALUES('tweet_video_worker_key_hash',?,0,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,revision=revision+1,updated_at=excluded.updated_at WHERE value<>excluded.value",
      [createHash('sha256').update(config.token).digest('hex'), new Date().toISOString()]);
    writeFileSync(`${configPath}.next`, JSON.stringify(config), { mode: 0o600 });
    renameSync(`${configPath}.next`, configPath);
    const release = `${root}/releases/${request.sha}/server`;
    mkdirSync(release, { recursive: true, mode: 0o700 });
    for (const name of ['tweet-video-worker.js', 'x-video-source.js']) copyFileSync(`dist-server/server/${name}`, `${release}/${name}`);
    mkdirSync(`${root}/releases/${request.sha}/shared`, { recursive: true, mode: 0o700 });
    copyFileSync('dist-server/shared/tweet-video.js', `${root}/releases/${request.sha}/shared/tweet-video.js`);
    writeFileSync(`${root}/releases/${request.sha}/package.json`, '{"type":"module"}', { mode: 0o600 });
    const fingerprint = createHash('sha256');
    for (const file of ['dist-server/server/tweet-video-worker.js', 'dist-server/server/x-video-source.js', 'dist-server/shared/tweet-video.js', 'cloud/video.ts', 'cloud/assets.ts', 'cloud/clip.ts']) fingerprint.update(readFileSync(file));
    writeFileSync(`${root}/releases/${request.sha}/fingerprint`, fingerprint.digest('hex'), { mode: 0o600 });
    console.log('Tweet video worker prepared; no broad Cloudflare token persisted.');
    return;
  }
  assert.equal(mode, 'activate');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const response = await fetcher(`${endpoint}/health`, { headers: { Authorization: `Bearer ${config.token}` }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  assert(response.ok && (await response.json()).ok === true, 'Published video worker health check failed');
  const fingerprint = readFileSync(`${root}/releases/${request.sha}/fingerprint`, 'utf8');
  const previous = existsSync(`${root}/last-acceptance.json`) ? JSON.parse(readFileSync(`${root}/last-acceptance.json`, 'utf8')) : null;
  let acceptance = 'reused';
  if (previous?.fingerprint !== fingerprint) {
    const { processVideoJob } = await import(pathToFileURL(`${root}/releases/${request.sha}/server/tweet-video-worker.js`).href);
    const [{ value: epoch }] = await query("SELECT value FROM app_settings WHERE key='data_epoch'");
    assert(epoch && !epoch.startsWith('restore:'), 'Video verification cannot run during restore');
    for (const [maxBytes, expected] of [[20_000_000, 'ready'], [1_000_000, 'skipped']]) {
      const id = randomUUID(), documentId = randomUUID(), leaseToken = randomUUID();
      const sourceUrl = 'https://x.com/i/status/1577855540407197696';
      const text = '视频下载发布验证：文字与图片必须保留。';
      const now = new Date().toISOString();
      try {
        await query("INSERT INTO cloud_documents(id,source_url,title,markdown,status,source_note,revision,created_at,updated_at) VALUES(?,?,?,?,'ready','发布自检',1,?,?)",
          [documentId, sourceUrl, '视频功能发布验证（自动清理）', text, now, now]);
        await query("INSERT INTO cloud_tweet_video_jobs(id,document_id,epoch,source_url,max_bytes,status,lease_token,lease_until,attempts,created_at,updated_at) VALUES(?,?,?,?,?,'processing',?,?,1,?,?)",
          [id, documentId, epoch, sourceUrl, maxBytes, leaseToken, Math.floor(Date.now()/1000)+900, now, now]);
        const result = await processVideoJob(config, { id, documentId, sourceUrl, maxBytes, epoch, leaseToken });
        assert.equal(result.status, expected, 'Live video download/limit verification failed');
        const [document] = await query('SELECT markdown FROM cloud_documents WHERE id=?', [documentId]);
        assert(document.markdown.startsWith(text), 'Video verification changed original text');
        if (expected === 'ready') assert(document.markdown.includes('![推文视频 1](zhiye://asset/'), 'Video asset was not attached');
        else { assert.equal(result.errorCode, 'VIDEO_TOO_LARGE'); assert.equal(document.markdown, text); }
      } finally { await query('DELETE FROM cloud_documents WHERE id=?', [documentId]); }
    }
    acceptance = 'download-and-over-limit-passed';
    writeFileSync(`${root}/last-acceptance.json`, JSON.stringify({ fingerprint, source: request.sha }), { mode: 0o600 });
  }
  const link = `${root}/current.${process.pid}`;
  symlinkSync(`${root}/releases/${request.sha}`, link);
  renameSync(link, `${root}/current`);
  let cron = '';
  try { cron = execFileSync('crontab', ['-l'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch (error) { assert(error.status === 1 && /no crontab/i.test(String(error.stderr)), 'User crontab is unavailable'); }
  execFileSync('crontab', ['-'], { input: mergeWorkerCron(cron, cronEntry(process.execPath, `${root}/current/server/tweet-video-worker.js`, configPath)), stdio: ['pipe', 'pipe', 'pipe'] });
  const evidencePath = resolve(dirname(requestPath), 'evidence.json');
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
  writeFileSync(evidencePath, JSON.stringify({ ...evidence, videoWorker: { status: 'ready', source: request.sha, health: 'passed', intervalSeconds: 60, acceptance } }, null, 2));
  console.log('Tweet video background downloader installed; authenticated health passed.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  configureVideoWorker(process.argv[2], process.argv[3]).catch(() => { console.error('Tweet video worker setup failed; inspect stage and service prerequisites.'); process.exitCode = 1; });
}
