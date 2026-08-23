import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { verifyBackup } from "../server/backup.js";
import { importCloudJsonBackup } from "../server/cloud-backup.js";
import { CURRENT_SCHEMA_VERSION, openDatabase } from "../server/db.js";

function workspace() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "zhiye-cloud-import-")));
  const dataDir = join(root, "data");
  const backupRoot = join(root, "backups");
  const db = openDatabase(dataDir);
  return { root, dataDir, backupRoot, db };
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

const uuid = () => crypto.randomUUID();

function cloudArchive() {
  const folderId = uuid();
  const documentId = uuid();
  const resultId = uuid();
  const timestamp = "2026-08-24T00:00:00.000Z";
  return {
    format: "zhiye-cloud-backup",
    version: 4,
    createdAt: timestamp,
    folders: [
      { id: folderId, name: "Cloud folder", created_at: timestamp, updated_at: timestamp },
    ],
    documents: [
      {
        id: documentId,
        source_url: "https://example.com/cloud-doc",
        final_url: "https://example.com/cloud-doc",
        canonical_url: null,
        title: "Cloud title",
        author: null,
        published_at: null,
        markdown: "# Cloud body",
        status: "ready",
        source_note: "Imported from cloud",
        folder_id: folderId,
        revision: 1,
        created_at: timestamp,
        updated_at: timestamp,
        deleted_at: null,
        favorite: 1,
      },
    ],
    derivedResults: [
      {
        id: resultId,
        document_id: documentId,
        type: "summary",
        target_language: null,
        model: "claude",
        endpoint_id: "endpoint-1",
        prompt_version: "summary-v1",
        input_hash: sha256("title:" + "markdown:"),
        output: "A short summary.",
        duration_ms: 250,
        usage_json: null,
        source_chars: 20,
        sent_chars: 20,
        truncated: 0,
        pinned: 0,
        source_revision: 1,
        created_at: timestamp,
      },
    ],
    llmSettings: {
      value: JSON.stringify({
        enabled: false,
        target: "remote",
        remote: { endpointUrl: "https://example.com/llm", model: "claude" },
        local: { endpointUrl: "http://localhost:11434", model: "llama", trusted: false },
      }),
      revision: 1,
    },
  };
}

test("importCloudJsonBackup converts a cloud archive into a restorable .zhiye-backup", async (t) => {
  const { root, dataDir, backupRoot, db } = workspace();
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  const bytes = new TextEncoder().encode(JSON.stringify(cloudArchive()));
  const record = await importCloudJsonBackup(db, dataDir, backupRoot, bytes, CURRENT_SCHEMA_VERSION);

  assert.equal(record.status, "verified");
  assert.ok(record.directoryName && /^backup-/.test(record.directoryName));
  assert.equal(record.schemaVersion, CURRENT_SCHEMA_VERSION);

  const backupPath = join(backupRoot, record.directoryName!);
  const verified = await verifyBackup(backupPath);
  assert.equal(verified.manifest.format, "zhiye-backup");
  assert.equal(verified.manifest.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.ok(verified.manifest.files.some((file) => file.path === "database.sqlite3"));

  // The produced backup must contain the imported document, folder, AI result and LLM settings.
  const sql = new DatabaseSync(join(backupPath, "database.sqlite3"), { readOnly: true });
  try {
    const document = sql.prepare("SELECT id, title, source_url, favorite FROM documents").get() as {
      id: string;
      title: string;
      source_url: string;
      favorite: number;
    };
    assert.equal(document.title, "Cloud title");
    assert.equal(document.source_url, "https://example.com/cloud-doc");
    assert.equal(document.favorite, 1);

    const folder = sql.prepare("SELECT name FROM folders").get() as { name: string };
    assert.equal(folder.name, "Cloud folder");

    const result = sql.prepare("SELECT type, output FROM derived_results").get() as { type: string; output: string };
    assert.equal(result.type, "summary");
    assert.equal(result.output, "A short summary.");

    const settings = sql.prepare("SELECT value FROM app_settings WHERE key = 'llm'").get() as { value: string };
    assert.ok(JSON.parse(settings.value).local.trusted === false);
  } finally {
    sql.close();
  }
});

test("importCloudJsonBackup accepts a cloud default llm revision of 0", async (t) => {
  const { root, dataDir, backupRoot, db } = workspace();
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  // A cloud account that never edited LLM settings exports revision 0; the
  // local app_settings table requires revision >= 1, so the import must clamp.
  const payload = cloudArchive();
  payload.llmSettings!.revision = 0;
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const record = await importCloudJsonBackup(db, dataDir, backupRoot, bytes, CURRENT_SCHEMA_VERSION);

  assert.equal(record.status, "verified");
  const sql = new DatabaseSync(join(backupRoot, record.directoryName!, "database.sqlite3"), { readOnly: true });
  try {
    const settings = sql.prepare("SELECT revision FROM app_settings WHERE key = 'llm'").get() as { revision: number };
    assert.ok(settings.revision >= 1);
  } finally {
    sql.close();
  }
});

test("importCloudJsonBackup rejects a malformed cloud archive", async (t) => {
  const { root, dataDir, backupRoot, db } = workspace();
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  const payload = cloudArchive();
  payload.documents[0].title = "";
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  await assert.rejects(
    importCloudJsonBackup(db, dataDir, backupRoot, bytes, CURRENT_SCHEMA_VERSION),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_BACKUP_ARCHIVE",
  );
  // No backup directory should have been recorded.
  assert.equal(db.listBackupRecords().length, 0);
  assert.equal(existsSync(backupRoot) ? readdirSync(backupRoot).length : 0, 0);
});
