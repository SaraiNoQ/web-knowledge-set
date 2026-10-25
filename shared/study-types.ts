import type { DocumentSummary, LibraryItemKind } from "./types.js";
import type { SourceAnchor, ReadingAnnotation } from "./reader-tools.js";

export interface StudyDocument extends Pick<DocumentSummary, "id" | "title" | "sourceUrl" | "kind" | "revision" | "deletedAt" | "folderId" | "tags"> {
  markdown: string;
  markdownEdited?: boolean;
  sections?: Array<{ text: string; pageNumber?: number; blockId?: string; source: SourceAnchor["source"] }>;
}
export interface StudyTopic { id: string; name: string; note: string; revision: number; createdAt: string; updatedAt: string; documentIds: string[]; annotationIds: string[] }
export interface StudyTopicDetail extends StudyTopic { documents: StudyDocument[]; annotations: ReadingAnnotation[] }
export interface ReadingProgress { documentId: string; documentRevision: number; revision: number; fraction: number; anchor: SourceAnchor | null; read: boolean; updatedAt: string }
export interface ReviewItem { annotation: ReadingAnnotation; documentTitle: string; documentRevision: number; dueAt: string | null; intervalDays: number; repetitions: number; revision: number }
export interface MergeRecord { id: string; keepId: string; sourceId: string; keepTitle: string; sourceTitle: string; createdAt: string; undone: boolean }
export interface DuplicateCandidate { source: StudyDocument; target: StudyDocument; score: number; reason: string }
export interface LinkHealth { documentId: string; url: string; status: number | null; state: "ok" | "unavailable" | "restricted" | "unknown"; checkedAt: string; message: string }
export interface QuestionCitation { id: string; documentId: string; documentRevision: number; title: string; anchor: SourceAnchor }
export interface StudyAnswer { answer: string; citations: QuestionCitation[]; refused: boolean }
export type ReviewGrade = "again" | "hard" | "good" | "easy";
export interface StudyAdapter {
  documentsTable: "documents" | "cloud_documents";
  all(sql: string, values: unknown[]): Promise<Record<string, unknown>[]>;
  run(sql: string, values: unknown[]): Promise<number>;
  batch(statements: Array<{ sql: string; values: unknown[] }>): Promise<void>;
  document(id: string): Promise<StudyDocument | null>;
}
