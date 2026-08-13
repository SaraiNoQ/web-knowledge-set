import { randomUUID } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENDPOINT = "https://api.deepseek.com/chat/completions";
const MODEL = "deepseek-v4-flash";
const FIXTURE = readFileSync(join(ROOT, "tests/fixtures/deepseek-translation.md"), "utf8");
const LINK = "https://example.com/guides?source=zhiye#safe";
const INLINE_CODE = "`pnpm verify`";
const CODE_BLOCK = "```sh\nprintf '%s\\n' 'keep this code unchanged'\n```";

class AcceptanceError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(code) {
  throw new AcceptanceError(code);
}

function codeFor(error) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  return /^[A-Z][A-Z0-9_]{0,63}$/u.test(code) ? code : "SMOKE_INTERNAL_ERROR";
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolveClose) => server.close(resolveClose));
}

function assertSecretAbsent(path, apiKey) {
  const secret = Buffer.from(apiKey, "utf8");
  const visit = (entry) => {
    const stat = lstatSync(entry);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const name of readdirSync(entry)) visit(join(entry, name));
    } else if (stat.isFile() && readFileSync(entry).includes(secret)) {
      fail("SMOKE_SECRET_PERSISTED");
    }
  };
  visit(path);
}

async function runAcceptance(apiKey, resolveLlmTarget) {
  if (typeof apiKey !== "string" || !apiKey.trim()) fail("SMOKE_KEY_MISSING");
  apiKey = apiKey.trim();
  const started = Date.now();
  const [{ createApp }, { openDatabase }] = await Promise.all([
    import(pathToFileURL(join(ROOT, "dist-server/server/app.js")).href),
    import(pathToFileURL(join(ROOT, "dist-server/server/db.js")).href),
  ]);
  const root = mkdtempSync(join(tmpdir(), "zhiye-deepseek-"));
  const dataDir = join(root, "data");
  let database;
  let app;
  try {
    database = openDatabase(dataDir);
    app = createApp({
      dataDir,
      database,
      bootstrapToken: randomUUID(),
      sessionToken: randomUUID(),
      startWorker: false,
      trustedLocalhost: false,
      ...(resolveLlmTarget ? { resolveLlmTarget } : {}),
    });
  } catch (error) {
    database?.close();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  const server = createServer((request, response) => void app.handler(request, response));
  let keyLoaded = false;
  let persistedExpectation = null;
  let api;
  try {
    await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") fail("SMOKE_SERVER_START_FAILED");
    const base = `http://127.0.0.1:${address.port}`;
    const launch = await fetch(`${base}/launch?token=${encodeURIComponent(app.bootstrapToken)}`, { redirect: "manual" })
      .catch(() => fail("SMOKE_LOCAL_API_UNREACHABLE"));
    const cookie = (launch.headers.get("set-cookie") ?? "").split(";", 1)[0];
    if (launch.status !== 302 || !cookie) fail("SMOKE_SESSION_FAILED");
    const initialResponse = await fetch(`${base}/api/settings/llm`, { headers: { Cookie: cookie } })
      .catch(() => fail("SMOKE_LOCAL_API_UNREACHABLE"));
    const epoch = initialResponse.headers.get("x-zhiye-data-epoch");
    if (!initialResponse.ok || !epoch) fail("SMOKE_SETTINGS_FAILED");
    const initial = await initialResponse.json().catch(() => fail("SMOKE_INVALID_API_RESPONSE"));
    const headers = {
      Cookie: cookie,
      Origin: base,
      "Content-Type": "application/json",
      "X-Zhiye-Data-Epoch": epoch,
    };
    api = async (path, options = {}) => {
      const response = await fetch(`${base}${path}`, {
        ...options,
        headers: { Cookie: cookie, ...(options.method && options.method !== "GET" ? headers : {}), ...options.headers },
      }).catch(() => fail("SMOKE_LOCAL_API_UNREACHABLE"));
      const value = await response.json().catch(() => fail("SMOKE_INVALID_API_RESPONSE"));
      if (!response.ok) {
        const errorCode = value && typeof value === "object" && value.error && typeof value.error === "object"
          ? value.error.code
          : null;
        fail(typeof errorCode === "string" ? errorCode : `SMOKE_HTTP_${response.status}`);
      }
      return value;
    };

    const preview = await api("/api/imports/preview", {
      method: "POST",
      body: JSON.stringify({ kind: "markdown", files: [{ path: "deepseek-translation.md", content: FIXTURE }] }),
    });
    if (preview?.counts?.valid !== 1 || preview?.counts?.invalid !== 0) fail("SMOKE_FIXTURE_IMPORT_FAILED");
    const applied = await api(`/api/imports/${encodeURIComponent(preview.id)}/apply`, {
      method: "POST",
      body: JSON.stringify({ strategy: "skip" }),
    });
    const documentId = applied?.items?.find((item) => item.status === "created")?.documentId;
    if (typeof documentId !== "string") fail("SMOKE_FIXTURE_IMPORT_FAILED");
    const original = await api(`/api/documents/${encodeURIComponent(documentId)}`);
    if (original.markdown !== FIXTURE) fail("SMOKE_FIXTURE_CHANGED");

    const keyStatus = await api("/api/settings/llm/key", {
      method: "PUT",
      body: JSON.stringify({ apiKey, endpointUrl: ENDPOINT }),
    });
    keyLoaded = true;
    if (keyStatus?.configured !== true || keyStatus?.endpointUrl !== ENDPOINT) fail("SMOKE_KEY_BINDING_FAILED");

    const probe = await api("/api/settings/llm/test", {
      method: "POST",
      body: JSON.stringify({ target: "remote", endpointUrl: ENDPOINT, model: MODEL }),
    });
    if (probe?.ok !== true || probe?.target !== "remote" || probe?.model !== MODEL) fail("SMOKE_PROBE_FAILED");

    const settings = await api("/api/settings/llm", {
      method: "PUT",
      body: JSON.stringify({
        enabled: true,
        target: "remote",
        remote: { endpointUrl: ENDPOINT, model: MODEL },
        local: { endpointUrl: "", model: "", trusted: false },
        revision: initial.revision,
      }),
    });
    const derivedPreview = await api(`/api/documents/${encodeURIComponent(documentId)}/derived-preview`, {
      method: "POST",
      body: JSON.stringify({ type: "translation", targetLanguage: "zh-CN", revision: original.revision }),
    });
    const task = await api(`/api/documents/${encodeURIComponent(documentId)}/derived-task`, {
      method: "POST",
      body: JSON.stringify({
        type: "translation",
        targetLanguage: "zh-CN",
        revision: derivedPreview.revision,
        inputHash: derivedPreview.inputHash,
        sendHash: derivedPreview.sendHash,
        settingsRevision: derivedPreview.settingsRevision,
      }),
    });
    const deadline = Date.now() + 90_000;
    let completed = task;
    while (completed?.status === "running" && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
      completed = await api(`/api/derived-tasks/${encodeURIComponent(task.id)}`);
    }
    if (completed?.status === "running") fail("LLM_TIMEOUT");
    if (completed?.status !== "succeeded") fail(codeFor(completed?.error));
    const result = completed.result;
    if (result?.model !== MODEL || result?.type !== "translation" || result?.targetLanguage !== "zh-CN") {
      fail("SMOKE_RESULT_METADATA_FAILED");
    }
    const output = result.output;
    if (typeof output !== "string" || output === FIXTURE || !/[\u3400-\u9fff]/u.test(output)) {
      fail("SMOKE_TRANSLATION_FAILED");
    }
    if (!output.includes(`](${LINK})`) || !output.includes(INLINE_CODE) || !output.includes(CODE_BLOCK) ||
        output.split("\n").filter((line) => line.startsWith("- ")).length !== 2) {
      fail("SMOKE_MARKDOWN_CHANGED");
    }
    const unchanged = await api(`/api/documents/${encodeURIComponent(documentId)}`);
    if (unchanged.markdown !== FIXTURE || unchanged.revision !== original.revision) fail("SMOKE_SOURCE_OVERWRITTEN");
    const persisted = await api(`/api/documents/${encodeURIComponent(documentId)}/derived-results?page=1`);
    const saved = persisted?.items?.find((item) => item.id === result.id);
    if (!saved || saved.output !== output) fail("SMOKE_RESULT_NOT_PERSISTED");
    if (settings?.remote?.model !== MODEL) fail("SMOKE_SETTINGS_FAILED");
    persistedExpectation = { documentId, revision: original.revision, resultId: result.id, output };
    return Date.now() - started;
  } finally {
    if (keyLoaded && api) {
      await api("/api/settings/llm/key", { method: "DELETE", body: "{}" }).catch(() => undefined);
    }
    await closeServer(server).catch(() => undefined);
    await app.close().catch(() => undefined);
    try {
      if (persistedExpectation) {
        const reopened = openDatabase(dataDir);
        try {
          const document = reopened.getDocument(persistedExpectation.documentId);
          const result = reopened.listDerivedResults(persistedExpectation.documentId)?.items
            .find((item) => item.id === persistedExpectation.resultId);
          if (document?.markdown !== FIXTURE || document?.revision !== persistedExpectation.revision) {
            fail("SMOKE_SOURCE_NOT_PERSISTED");
          }
          if (result?.output !== persistedExpectation.output) fail("SMOKE_RESULT_NOT_PERSISTED");
        } finally {
          reopened.close();
        }
      }
      assertSecretAbsent(root, apiKey);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

async function selfTest() {
  const apiKey = "self-test-deepseek-key";
  const calls = [];
  const provider = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      response.writeHead(400).end();
      return;
    }
    const user = body?.messages?.at(-1)?.content;
    const probe = user === "Reply with exactly ZHIYE_OK.";
    calls.push(probe ? "probe" : "translation");
    const authorized = request.headers.authorization === `Bearer ${apiKey}`;
    const modelMatches = body?.model === MODEL;
    let content = "";
    try {
      content = probe ? "ZHIYE_OK" : JSON.stringify(JSON.parse(user).map(({ id }) => ({ id, text: `翻译${id}` })));
    } catch {
      response.writeHead(422, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { code: "invalid_input" } }));
      return;
    }
    response.writeHead(authorized && modelMatches ? 200 : 401, {
      "Content-Type": "application/json",
      "Content-Encoding": "identity",
    });
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise((resolveListen) => provider.listen(0, "127.0.0.1", resolveListen));
  const address = provider.address();
  if (!address || typeof address === "string") fail("SMOKE_SELF_TEST_FAILED");
  try {
    const duration = await runAcceptance(apiKey, async (kind, input) => {
      if (kind !== "remote" || input !== ENDPOINT) fail("SMOKE_SELF_TEST_FAILED");
      return { url: new URL(`http://127.0.0.1:${address.port}/chat/completions`), address: "127.0.0.1", family: 4 };
    });
    if (calls.join(",") !== "probe,translation") fail("SMOKE_SELF_TEST_FAILED");
    return duration;
  } finally {
    await closeServer(provider);
  }
}

const selfTesting = process.argv.length === 3 && process.argv[2] === "--self-test";
const unexpectedArguments = process.argv.length !== (selfTesting ? 3 : 2);
const rawKey = process.env.DEEPSEEK_API_KEY;
delete process.env.DEEPSEEK_API_KEY;
const started = Date.now();
try {
  if (unexpectedArguments) fail("SMOKE_INVALID_ARGUMENTS");
  const duration = selfTesting ? await selfTest() : await runAcceptance(rawKey);
  process.stdout.write(`status=passed model=${MODEL} duration_ms=${duration} code=OK\n`);
} catch (error) {
  process.stdout.write(`status=failed model=${MODEL} duration_ms=${Date.now() - started} code=${codeFor(error)}\n`);
  process.exitCode = 1;
}
