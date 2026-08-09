import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  CaptureErrorCode,
  CaptureMode,
  CaptureStatus,
  DocumentListResponse,
  DocumentRevision,
  DocumentSummary,
  KnowledgeDocument,
} from "../shared/types.js";

const PAGE_SIZE = 30;

const migrations = [
  `
  CREATE TABLE documents (
    id TEXT PRIMARY KEY,
    source_url TEXT NOT NULL UNIQUE,
    canonical_url TEXT,
    title TEXT NOT NULL,
    author TEXT,
    published_at TEXT,
    markdown TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status IN ('queued', 'fetching', 'extracting', 'ready', 'failed')),
    warning TEXT,
    error_code TEXT,
    error_message TEXT,
    capture_mode TEXT CHECK (capture_mode IS NULL OR capture_mode IN ('http', 'browser')),
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE captures (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    job_id INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('fetching', 'extracting', 'ready', 'failed')),
    mode TEXT CHECK (mode IS NULL OR mode IN ('http', 'browser')),
    http_status INTEGER,
    snapshot_path TEXT,
    warning TEXT,
    error_code TEXT,
    error_message TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT
  );

  CREATE TABLE capture_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    available_at TEXT NOT NULL,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE UNIQUE INDEX capture_jobs_one_active
    ON capture_jobs(document_id)
    WHERE status IN ('queued', 'running');
  CREATE INDEX capture_jobs_next ON capture_jobs(status, available_at, id);
  CREATE INDEX captures_document ON captures(document_id, started_at DESC);

  CREATE TABLE tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE
  );

  CREATE TABLE document_tags (
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (document_id, tag_id)
  );
  CREATE INDEX document_tags_tag ON document_tags(tag_id, document_id);

  CREATE VIRTUAL TABLE documents_fts USING fts5(
    title,
    markdown,
    content='documents',
    content_rowid='rowid',
    tokenize='unicode61'
  );

  CREATE TRIGGER documents_fts_insert AFTER INSERT ON documents BEGIN
    INSERT INTO documents_fts(rowid, title, markdown)
    VALUES (new.rowid, new.title, new.markdown);
  END;
  CREATE TRIGGER documents_fts_delete AFTER DELETE ON documents BEGIN
    INSERT INTO documents_fts(documents_fts, rowid, title, markdown)
    VALUES ('delete', old.rowid, old.title, old.markdown);
  END;
  CREATE TRIGGER documents_fts_update AFTER UPDATE OF title, markdown ON documents BEGIN
    INSERT INTO documents_fts(documents_fts, rowid, title, markdown)
    VALUES ('delete', old.rowid, old.title, old.markdown);
    INSERT INTO documents_fts(rowid, title, markdown)
    VALUES (new.rowid, new.title, new.markdown);
  END;
  `,
  `
  ALTER TABLE documents ADD COLUMN title_edited INTEGER NOT NULL DEFAULT 0
    CHECK (title_edited IN (0, 1));
  ALTER TABLE documents ADD COLUMN markdown_edited INTEGER NOT NULL DEFAULT 0
    CHECK (markdown_edited IN (0, 1));

  DROP TRIGGER documents_fts_insert;
  DROP TRIGGER documents_fts_delete;
  DROP TRIGGER documents_fts_update;
  DROP TABLE documents_fts;

  CREATE VIRTUAL TABLE documents_fts USING fts5(
    title,
    markdown,
    source_url,
    content='documents',
    content_rowid='rowid',
    tokenize='trigram'
  );
  INSERT INTO documents_fts(rowid, title, markdown, source_url)
    SELECT rowid, title, markdown, source_url FROM documents;

  CREATE TRIGGER documents_fts_insert AFTER INSERT ON documents BEGIN
    INSERT INTO documents_fts(rowid, title, markdown, source_url)
    VALUES (new.rowid, new.title, new.markdown, new.source_url);
  END;
  CREATE TRIGGER documents_fts_delete AFTER DELETE ON documents BEGIN
    INSERT INTO documents_fts(documents_fts, rowid, title, markdown, source_url)
    VALUES ('delete', old.rowid, old.title, old.markdown, old.source_url);
  END;
  CREATE TRIGGER documents_fts_update AFTER UPDATE OF title, markdown, source_url ON documents BEGIN
    INSERT INTO documents_fts(documents_fts, rowid, title, markdown, source_url)
    VALUES ('delete', old.rowid, old.title, old.markdown, old.source_url);
    INSERT INTO documents_fts(rowid, title, markdown, source_url)
    VALUES (new.rowid, new.title, new.markdown, new.source_url);
  END;
  `,
  `
  ALTER TABLE documents ADD COLUMN final_url TEXT;
  ALTER TABLE captures ADD COLUMN request_url TEXT;
  ALTER TABLE captures ADD COLUMN final_url TEXT;
  ALTER TABLE captures ADD COLUMN extracted_title TEXT;
  ALTER TABLE captures ADD COLUMN extracted_author TEXT;
  ALTER TABLE captures ADD COLUMN extracted_published_at TEXT;
  ALTER TABLE captures ADD COLUMN extracted_canonical_url TEXT;
  ALTER TABLE captures ADD COLUMN extracted_markdown TEXT;

  UPDATE captures SET request_url = (
    SELECT source_url FROM documents WHERE documents.id = captures.document_id
  ) WHERE request_url IS NULL;
  `,
  `
  ALTER TABLE documents ADD COLUMN deleted_at TEXT;
  CREATE INDEX documents_deleted_updated ON documents(deleted_at, updated_at DESC);

  CREATE TABLE document_revisions (
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    title TEXT NOT NULL,
    markdown TEXT NOT NULL,
    tags_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (document_id, revision)
  );
  CREATE INDEX document_revisions_document
    ON document_revisions(document_id, revision DESC);

  INSERT INTO document_revisions(document_id, revision, title, markdown, tags_json, created_at)
  SELECT d.id, d.revision, d.title, d.markdown,
         COALESCE((
           SELECT json_group_array(name) FROM (
             SELECT t.name AS name FROM tags t
             JOIN document_tags dt ON dt.tag_id = t.id
             WHERE dt.document_id = d.id
             ORDER BY lower(t.name), t.name
           )
         ), '[]'),
         d.updated_at
  FROM documents d;
  `,
  `
  CREATE TABLE file_deletions (
    path TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
];

interface DocumentRow {
  id: string;
  source_url: string;
  final_url: string | null;
  canonical_url: string | null;
  title: string;
  author: string | null;
  published_at: string | null;
  markdown: string;
  status: CaptureStatus;
  warning: string | null;
  error_code: CaptureErrorCode | null;
  error_message: string | null;
  capture_mode: CaptureMode | null;
  revision: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CaptureJob {
  id: number;
  captureId: string;
  documentId: string;
  url: string;
}

export interface CaptureResult {
  title: string;
  author: string | null;
  publishedAt: string | null;
  finalUrl: string;
  canonicalUrl: string | null;
  markdown: string;
  mode: CaptureMode;
  warning: string | null;
  httpStatus: number | null;
}

export interface DocumentPatch {
  title?: string;
  markdown?: string;
  tags?: string[];
}

export interface ListFilters {
  q?: string;
  tag?: string;
  status?: CaptureStatus;
  page?: number;
  trash?: "only";
}

function now() {
  return new Date().toISOString();
}

function transaction<T>(sql: DatabaseSync, work: () => T): T {
  sql.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    sql.exec("COMMIT");
    return result;
  } catch (error) {
    sql.exec("ROLLBACK");
    throw error;
  }
}

function ftsQuery(query: string) {
  return query
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" AND ");
}

function searchTerms(query: string) {
  return query.trim().split(/\s+/u).filter(Boolean);
}

function escapeLike(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

export class KnowledgeDatabase {
  readonly dataDir: string;
  readonly snapshotsDir: string;
  readonly sql: DatabaseSync;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.snapshotsDir = join(dataDir, "snapshots");
    mkdirSync(this.snapshotsDir, { recursive: true, mode: 0o700 });
    chmodSync(this.snapshotsDir, 0o700);
    const databasePath = join(dataDir, "zhiye.sqlite3");
    this.sql = new DatabaseSync(databasePath);
    this.sql.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    chmodSync(databasePath, 0o600);
    for (const suffix of ["-wal", "-shm"]) {
      const path = `${databasePath}${suffix}`;
      if (existsSync(path)) chmodSync(path, 0o600);
    }
    this.migrate();
    this.processPendingFileDeletions();
    this.recoverInterruptedJobs();
  }

  private migrate() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    const applied = new Set(
      (this.sql.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map(
        ({ version }) => version,
      ),
    );
    migrations.forEach((migration, index) => {
      const version = index + 1;
      if (applied.has(version)) return;
      transaction(this.sql, () => {
        this.sql.exec(migration);
        this.sql
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run(version, now());
      });
    });
  }

  private recoverInterruptedJobs() {
    const timestamp = now();
    transaction(this.sql, () => {
      this.sql
        .prepare(
          `UPDATE captures
           SET status = 'failed', error_code = 'INTERNAL_ERROR',
               error_message = 'Capture interrupted by application restart', finished_at = ?
           WHERE status IN ('fetching', 'extracting')`,
        )
        .run(timestamp);
      this.sql
        .prepare(
          `UPDATE capture_jobs
           SET status = 'queued', available_at = ?, updated_at = ?,
               last_error = 'Interrupted by application restart'
           WHERE status = 'running'`,
        )
        .run(timestamp, timestamp);
      this.sql
        .prepare(
          `UPDATE documents SET status = 'queued', updated_at = ?
           WHERE status IN ('fetching', 'extracting')`,
        )
        .run(timestamp);
    });
  }

  close() {
    this.sql.close();
  }

  private tagsFor(documentId: string) {
    return (
      this.sql
        .prepare(
          `SELECT t.name FROM tags t
           JOIN document_tags dt ON dt.tag_id = t.id
           WHERE dt.document_id = ? ORDER BY lower(t.name), t.name`,
        )
        .all(documentId) as Array<{ name: string }>
    ).map(({ name }) => name);
  }

  private toDocument(row: DocumentRow): KnowledgeDocument {
    return {
      id: row.id,
      title: row.title,
      sourceUrl: row.source_url,
      finalUrl: row.final_url,
      canonicalUrl: row.canonical_url,
      author: row.author,
      publishedAt: row.published_at,
      markdown: row.markdown,
      status: row.status,
      warning: row.warning,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      captureMode: row.capture_mode,
      tags: this.tagsFor(row.id),
      revision: row.revision,
      deletedAt: row.deleted_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toSummary(row: DocumentRow): DocumentSummary {
    const { publishedAt: _publishedAt, markdown: _markdown, captureMode: _captureMode, ...summary } =
      this.toDocument(row);
    return summary;
  }

  getDocument(id: string) {
    const row = this.sql.prepare("SELECT * FROM documents WHERE id = ?").get(id) as
      | DocumentRow
      | undefined;
    return row ? this.toDocument(row) : null;
  }

  createOrGetDocument(sourceUrl: string): { document: KnowledgeDocument; created: boolean } {
    return transaction(this.sql, () => {
      const existing = this.sql.prepare("SELECT * FROM documents WHERE source_url = ?").get(sourceUrl) as
        | DocumentRow
        | undefined;
      if (existing) return { document: this.toDocument(existing), created: false };

      const id = randomUUID();
      const timestamp = now();
      const title = new URL(sourceUrl).hostname;
      this.sql
        .prepare(
          `INSERT INTO documents(
             id, source_url, title, status, created_at, updated_at
           ) VALUES (?, ?, ?, 'queued', ?, ?)`,
        )
        .run(id, sourceUrl, title, timestamp, timestamp);
      this.sql
        .prepare(
          `INSERT INTO capture_jobs(document_id, status, available_at, created_at, updated_at)
           VALUES (?, 'queued', ?, ?, ?)`,
        )
        .run(id, timestamp, timestamp, timestamp);
      return { document: this.getDocument(id)!, created: true };
    });
  }

  listDocuments(filters: ListFilters = {}): DocumentListResponse {
    const page = Math.max(1, Math.trunc(filters.page ?? 1));
    const where: string[] = [];
    const params: Array<string | number> = [];
    let from = "FROM documents d";

    where.push(filters.trash === "only" ? "d.deleted_at IS NOT NULL" : "d.deleted_at IS NULL");

    if (filters.q?.trim()) {
      const terms = searchTerms(filters.q);
      if (terms.every((term) => [...term].length >= 3)) {
        from += " JOIN documents_fts ON documents_fts.rowid = d.rowid";
        where.push("documents_fts MATCH ?");
        params.push(ftsQuery(filters.q));
      } else {
        for (const term of terms) {
          where.push(
            "(d.title LIKE ? ESCAPE '\\' OR d.markdown LIKE ? ESCAPE '\\' OR d.source_url LIKE ? ESCAPE '\\')",
          );
          const pattern = `%${escapeLike(term)}%`;
          params.push(pattern, pattern, pattern);
        }
      }
    }
    if (filters.tag?.trim()) {
      where.push(
        `EXISTS (
          SELECT 1 FROM document_tags dt JOIN tags t ON t.id = dt.tag_id
          WHERE dt.document_id = d.id AND t.name = ? COLLATE NOCASE
        )`,
      );
      params.push(filters.tag.trim());
    }
    if (filters.status) {
      where.push("d.status = ?");
      params.push(filters.status);
    }

    const condition = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    const totalRow = this.sql
      .prepare(`SELECT count(*) AS total ${from}${condition}`)
      .get(...params) as { total: number };
    const rows = this.sql
      .prepare(
        `SELECT d.id, d.source_url, d.final_url, d.canonical_url, d.title, d.author,
                NULL AS published_at, '' AS markdown, d.status, d.warning,
                d.error_code, d.error_message, NULL AS capture_mode,
                d.revision, d.deleted_at, d.created_at, d.updated_at
         ${from}${condition} ORDER BY d.updated_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, PAGE_SIZE, (page - 1) * PAGE_SIZE) as unknown as DocumentRow[];

    return {
      items: rows.map((row) => this.toSummary(row)),
      page,
      pageSize: PAGE_SIZE,
      total: Number(totalRow.total),
    };
  }

  listTags(trash?: "only") {
    return (
      this.sql
        .prepare(
          `SELECT t.name FROM tags t
           JOIN document_tags dt ON dt.tag_id = t.id
           JOIN documents d ON d.id = dt.document_id
           WHERE ${trash === "only" ? "d.deleted_at IS NOT NULL" : "d.deleted_at IS NULL"}
           GROUP BY t.id ORDER BY lower(t.name), t.name`,
        )
        .all() as Array<{ name: string }>
    ).map(({ name }) => name);
  }

  updateDocument(id: string, revision: number, patch: DocumentPatch) {
    return transaction(this.sql, () => {
      const current = this.getDocument(id);
      if (!current) return { kind: "missing" as const };
      if (current.deletedAt) return { kind: "deleted" as const, document: current };
      if (current.revision !== revision) return { kind: "conflict" as const, document: current };

      const assignments = ["revision = revision + 1", "updated_at = ?"];
      const values: Array<string | number> = [now()];
      if (patch.title !== undefined) {
        assignments.push("title = ?", "title_edited = 1");
        values.push(patch.title);
      }
      if (patch.markdown !== undefined) {
        assignments.push("markdown = ?", "markdown_edited = 1");
        values.push(patch.markdown);
      }
      this.sql
        .prepare(`UPDATE documents SET ${assignments.join(", ")} WHERE id = ?`)
        .run(...values, id);

      if (patch.tags !== undefined) this.replaceTags(id, patch.tags);
      const document = this.getDocument(id)!;
      this.recordRevision(document);
      return { kind: "updated" as const, document };
    });
  }

  private replaceTags(documentId: string, tags: string[]) {
    this.sql.prepare("DELETE FROM document_tags WHERE document_id = ?").run(documentId);
    for (const name of tags) {
      this.sql.prepare("INSERT INTO tags(name) VALUES (?) ON CONFLICT(name) DO NOTHING").run(name);
      const tag = this.sql.prepare("SELECT id FROM tags WHERE name = ? COLLATE NOCASE").get(name) as {
        id: number;
      };
      this.sql.prepare("INSERT INTO document_tags(document_id, tag_id) VALUES (?, ?)").run(documentId, tag.id);
    }
    this.sql.prepare("DELETE FROM tags WHERE NOT EXISTS (SELECT 1 FROM document_tags WHERE tag_id = tags.id)").run();
  }

  private recordRevision(document: KnowledgeDocument) {
    this.sql
      .prepare(
        `INSERT INTO document_revisions(document_id, revision, title, markdown, tags_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        document.id,
        document.revision,
        document.title,
        document.markdown,
        JSON.stringify(document.tags),
        document.updatedAt,
      );
  }

  listDocumentRevisions(id: string): DocumentRevision[] | null {
    if (!this.getDocument(id)) return null;
    return (
      this.sql
        .prepare(
          `SELECT revision, title, markdown, tags_json, created_at
           FROM document_revisions WHERE document_id = ? ORDER BY revision DESC`,
        )
        .all(id) as Array<{
        revision: number;
        title: string;
        markdown: string;
        tags_json: string;
        created_at: string;
      }>
    ).map((row) => ({
      revision: row.revision,
      title: row.title,
      markdown: row.markdown,
      tags: JSON.parse(row.tags_json) as string[],
      createdAt: row.created_at,
    }));
  }

  restoreDocumentRevision(id: string, targetRevision: number, currentRevision: number) {
    return transaction(this.sql, () => {
      const current = this.getDocument(id);
      if (!current) return { kind: "missing" as const };
      if (current.deletedAt) return { kind: "deleted" as const, document: current };
      if (current.revision !== currentRevision) return { kind: "conflict" as const, document: current };
      const target = this.sql
        .prepare(
          `SELECT title, markdown, tags_json FROM document_revisions
           WHERE document_id = ? AND revision = ?`,
        )
        .get(id, targetRevision) as { title: string; markdown: string; tags_json: string } | undefined;
      if (!target) return { kind: "revision_missing" as const };

      const timestamp = now();
      this.sql
        .prepare(
          `UPDATE documents SET title = ?, markdown = ?, title_edited = 1, markdown_edited = 1,
             revision = revision + 1, updated_at = ? WHERE id = ?`,
        )
        .run(target.title, target.markdown, timestamp, id);
      this.replaceTags(id, JSON.parse(target.tags_json) as string[]);
      const document = this.getDocument(id)!;
      this.recordRevision(document);
      return { kind: "restored" as const, document };
    });
  }

  softDeleteDocument(id: string) {
    return transaction(this.sql, () => {
      const current = this.getDocument(id);
      if (!current) return { kind: "missing" as const };
      if (current.deletedAt) return { kind: "already_deleted" as const, document: current };
      const timestamp = now();
      this.sql
        .prepare("UPDATE documents SET deleted_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?")
        .run(timestamp, timestamp, id);
      return { kind: "deleted" as const, document: this.getDocument(id)! };
    });
  }

  restoreDocument(id: string) {
    return transaction(this.sql, () => {
      const current = this.getDocument(id);
      if (!current) return { kind: "missing" as const };
      if (!current.deletedAt) return { kind: "not_deleted" as const, document: current };
      const timestamp = now();
      this.sql
        .prepare("UPDATE documents SET deleted_at = NULL, revision = revision + 1, updated_at = ? WHERE id = ?")
        .run(timestamp, id);
      return { kind: "restored" as const, document: this.getDocument(id)! };
    });
  }

  permanentlyDeleteDocument(id: string, revision: number) {
    const result = transaction(this.sql, () => {
      const current = this.getDocument(id);
      if (!current) return { kind: "missing" as const };
      if (!current.deletedAt) return { kind: "not_deleted" as const, document: current };
      if (current.revision !== revision) return { kind: "conflict" as const, document: current };
      const active = this.sql
        .prepare("SELECT 1 AS found FROM capture_jobs WHERE document_id = ? AND status = 'running' LIMIT 1")
        .get(id) as { found: number } | undefined;
      if (active) return { kind: "capture_running" as const, document: current };

      const relativePaths = (
        this.sql
          .prepare(
            `SELECT DISTINCT c.snapshot_path FROM captures c
             WHERE c.document_id = ? AND c.snapshot_path IS NOT NULL
               AND NOT EXISTS (
                 SELECT 1 FROM captures other
                 WHERE other.snapshot_path = c.snapshot_path AND other.document_id <> c.document_id
               )`,
          )
          .all(id) as Array<{ snapshot_path: string }>
      ).map(({ snapshot_path }) => snapshot_path);
      try {
        for (const relativePath of relativePaths) {
          const path = this.snapshotPath(relativePath);
          try {
            if (!lstatSync(path).isFile()) throw new Error("Snapshot path is not a file");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
      } catch {
        return { kind: "snapshot_failed" as const };
      }

      const timestamp = now();
      for (const path of relativePaths) {
        this.sql
          .prepare(
            `INSERT INTO file_deletions(path, created_at, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(path) DO NOTHING`,
          )
          .run(path, timestamp, timestamp);
      }
      this.sql.prepare("DELETE FROM documents WHERE id = ?").run(id);
      this.sql.prepare("DELETE FROM tags WHERE NOT EXISTS (SELECT 1 FROM document_tags WHERE tag_id = tags.id)").run();
      return { kind: "deleted" as const };
    });
    if (result.kind === "deleted") this.processPendingFileDeletions();
    return result;
  }

  private snapshotPath(relativePath: string) {
    const root = resolve(this.snapshotsDir);
    const match = /^snapshots\/([a-zA-Z0-9-]+\.html\.gz)$/u.exec(relativePath);
    if (!match || !lstatSync(root).isDirectory()) throw new Error("Snapshot path is outside storage");
    return join(root, match[1]);
  }

  processPendingFileDeletions() {
    const rows = this.sql.prepare("SELECT path FROM file_deletions ORDER BY created_at").all() as Array<{
      path: string;
    }>;
    for (const row of rows) {
      try {
        const path = this.snapshotPath(row.path);
        try {
          if (!lstatSync(path).isFile()) throw new Error("Snapshot path is not a file");
          unlinkSync(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        this.sql.prepare("DELETE FROM file_deletions WHERE path = ?").run(row.path);
      } catch (error) {
        this.sql
          .prepare(
            `UPDATE file_deletions SET attempts = attempts + 1, last_error = ?, updated_at = ?
             WHERE path = ?`,
          )
          .run(error instanceof Error ? error.message.slice(0, 1000) : "File deletion failed", now(), row.path);
      }
    }
  }

  retryDocument(id: string) {
    return transaction(this.sql, () => {
      const current = this.getDocument(id);
      if (!current) return { kind: "missing" as const };
      if (current.deletedAt) return { kind: "deleted" as const, document: current };
      if (current.status !== "failed") return { kind: "not_failed" as const, document: current };
      const timestamp = now();
      this.sql
        .prepare(
          `UPDATE documents
           SET status = 'queued', warning = NULL, error_code = NULL, error_message = NULL,
               revision = revision + 1, updated_at = ? WHERE id = ?`,
        )
        .run(timestamp, id);
      this.sql
        .prepare(
          `INSERT INTO capture_jobs(document_id, status, available_at, created_at, updated_at)
           VALUES (?, 'queued', ?, ?, ?)`,
        )
        .run(id, timestamp, timestamp, timestamp);
      return { kind: "queued" as const, document: this.getDocument(id)! };
    });
  }

  claimNextCapture(): CaptureJob | null {
    return transaction(this.sql, () => {
      const timestamp = now();
      const row = this.sql
        .prepare(
          `SELECT j.id, j.document_id, d.source_url
           FROM capture_jobs j JOIN documents d ON d.id = j.document_id
           WHERE j.status = 'queued' AND j.available_at <= ? AND d.deleted_at IS NULL
           ORDER BY j.id LIMIT 1`,
        )
        .get(timestamp) as { id: number; document_id: string; source_url: string } | undefined;
      if (!row) return null;

      const captureId = randomUUID();
      this.sql
        .prepare(
          `UPDATE capture_jobs
           SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?`,
        )
        .run(timestamp, row.id);
      this.sql
        .prepare("UPDATE documents SET status = 'fetching', updated_at = ? WHERE id = ?")
        .run(timestamp, row.document_id);
      this.sql
        .prepare(
          `INSERT INTO captures(id, document_id, job_id, request_url, status, started_at)
           VALUES (?, ?, ?, ?, 'fetching', ?)`,
        )
        .run(captureId, row.document_id, row.id, row.source_url, timestamp);
      return {
        id: row.id,
        captureId,
        documentId: row.document_id,
        url: row.source_url,
      };
    });
  }

  markExtracting(job: CaptureJob, mode: CaptureMode, httpStatus: number | null) {
    const timestamp = now();
    transaction(this.sql, () => {
      this.sql
        .prepare("UPDATE documents SET status = 'extracting', updated_at = ? WHERE id = ?")
        .run(timestamp, job.documentId);
      this.sql
        .prepare("UPDATE captures SET status = 'extracting', mode = ?, http_status = ? WHERE id = ?")
        .run(mode, httpStatus, job.captureId);
    });
  }

  planCaptureSnapshot(job: CaptureJob, snapshotPath: string) {
    this.snapshotPath(snapshotPath);
    const result = this.sql
      .prepare("UPDATE captures SET snapshot_path = ? WHERE id = ? AND document_id = ? AND job_id = ?")
      .run(snapshotPath, job.captureId, job.documentId, job.id);
    if (result.changes !== 1) throw new Error("Capture is no longer active");
  }

  completeCapture(job: CaptureJob, result: CaptureResult, snapshotPath: string | null) {
    const timestamp = now();
    transaction(this.sql, () => {
      this.sql
        .prepare(
          `UPDATE documents SET
             final_url = ?,
             canonical_url = ?,
             title = CASE WHEN title_edited = 0 THEN ? ELSE title END,
             author = ?, published_at = ?,
             markdown = CASE WHEN markdown_edited = 0 THEN ? ELSE markdown END,
             status = 'ready', warning = ?, error_code = NULL, error_message = NULL,
             capture_mode = ?, revision = revision + 1, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          result.finalUrl,
          result.canonicalUrl,
          result.title,
          result.author,
          result.publishedAt,
          result.markdown,
          result.warning,
          result.mode,
          timestamp,
          job.documentId,
        );
      this.sql
        .prepare(
          `UPDATE captures SET status = 'ready', mode = ?, http_status = ?, snapshot_path = ?,
             final_url = ?, extracted_title = ?, extracted_author = ?,
             extracted_published_at = ?, extracted_canonical_url = ?, extracted_markdown = ?,
             warning = ?, finished_at = ? WHERE id = ?`,
        )
        .run(
          result.mode,
          result.httpStatus,
          snapshotPath,
          result.finalUrl,
          result.title,
          result.author,
          result.publishedAt,
          result.canonicalUrl,
          result.markdown,
          result.warning,
          timestamp,
          job.captureId,
        );
      this.sql
        .prepare("UPDATE capture_jobs SET status = 'done', updated_at = ? WHERE id = ?")
        .run(timestamp, job.id);
      this.recordRevision(this.getDocument(job.documentId)!);
    });
    return this.getDocument(job.documentId)!;
  }

  failCapture(job: CaptureJob, code: CaptureErrorCode, message: string) {
    const timestamp = now();
    transaction(this.sql, () => {
      this.sql
        .prepare(
          `UPDATE documents SET status = 'failed', error_code = ?, error_message = ?,
             warning = NULL, revision = revision + 1, updated_at = ? WHERE id = ?`,
        )
        .run(code, message, timestamp, job.documentId);
      this.sql
        .prepare(
          `UPDATE captures SET status = 'failed', error_code = ?, error_message = ?,
             finished_at = ? WHERE id = ?`,
        )
        .run(code, message, timestamp, job.captureId);
      this.sql
        .prepare("UPDATE capture_jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?")
        .run(message, timestamp, job.id);
    });
    return this.getDocument(job.documentId)!;
  }

  hasPendingCaptures() {
    const row = this.sql
      .prepare(
        `SELECT 1 AS found FROM capture_jobs j JOIN documents d ON d.id = j.document_id
         WHERE j.status IN ('queued', 'running') AND d.deleted_at IS NULL LIMIT 1`,
      )
      .get() as { found: number } | undefined;
    return Boolean(row);
  }

}

export function openDatabase(dataDir: string) {
  return new KnowledgeDatabase(dataDir);
}
