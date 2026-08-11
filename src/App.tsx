import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ChangeEvent, FormEvent, KeyboardEvent, ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { invoke } from "@tauri-apps/api/core";
import type {
  BatchDocumentAction,
  CaptureHistoryItem,
  CaptureMode,
  CaptureQueueStatus,
  CaptureStatus,
  DocumentAsset,
  DocumentDraft,
  DocumentRevision,
  DocumentSummary,
  ImportApplyResult,
  ImportKind,
  ImportPreview,
  ImportStrategy,
  KnowledgeCollection,
  KnowledgeDocument,
  KnowledgeTag,
  RecentFilter,
  ReextractionPreview,
} from "../shared/types";
import { api, ApiRequestError } from "./api";
import type { DocumentPatch } from "./api";
import { AiSettings } from "./components/AiSettings";
import { DataSafety } from "./components/DataSafety";
import { DerivedKnowledge } from "./components/DerivedKnowledge";
import { MarkdownEditor } from "./components/MarkdownEditor";

type EditorMode = "edit" | "split" | "preview";
type SaveState = "idle" | "saving" | "saved" | "error" | "conflict";
type StatusFilter = CaptureStatus | "";
type LibraryView = "all" | "recent" | "favorites" | "unorganized" | "archived" | "failed" | "trash";
type SearchScope = "all" | "title" | "body" | "source";
type SortOrder = "updated" | "created" | "title";

type SavedFilter = RecentFilter;

function addRecentFilter(filters: SavedFilter[], saved: SavedFilter) {
  const signature = JSON.stringify({ ...saved, label: undefined });
  return [saved, ...filters.filter((value) => JSON.stringify({ ...value, label: undefined }) !== signature)].slice(0, 5);
}

interface Draft {
  title: string;
  markdown: string;
  tags: string[];
}

interface SourceMetadataDraft {
  author: string;
  publishedDate: string;
  sourceNote: string;
}

interface OrganizationConflict {
  server: KnowledgeDocument;
  patch: Omit<DocumentPatch, "revision">;
  successMessage: string;
  rebase?: (server: KnowledgeDocument) => Omit<DocumentPatch, "revision">;
}

interface RemoteDraftConflict {
  remote: DocumentDraft | null;
}

interface ImportDuplicatePrompt {
  document: DocumentSummary;
  kind: "source" | "resolved";
  url: string;
}

type ExternalIntent =
  | { kind: "capture"; url: string }
  | { kind: "markdown" | "bookmarks" | "bundle"; token: string; name: string }
  | { kind: "error"; message: string };

interface ExternalTextFile {
  name: string;
  content: string;
}

interface NavigationGuard {
  generation: number;
  selectedId: string | null;
  dirty: { documentId: string; draft: Draft } | null;
  metadata: { documentId: string; draft: SourceMetadataDraft } | null;
}

const ACTIVE_STATUSES = new Set<CaptureStatus>(["queued", "fetching", "extracting"]);
const STATUS_LABEL: Record<CaptureStatus, string> = {
  queued: "等待抓取",
  fetching: "正在读取网页",
  extracting: "正在织理正文",
  ready: "已就绪",
  failed: "抓取失败",
};

const IMPORT_PREVIEW_LABEL = { valid: "可导入", duplicate: "重复", invalid: "无效" } as const;
const IMPORT_RESULT_LABEL = { created: "已新增", updated: "已更新", skipped: "已跳过", conflict: "有冲突", failed: "失败" } as const;
const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 100 * 1024 * 1024;
const MAX_MARKDOWN_FILES = 100;

function importFileLimitError(kind: ImportKind, files: File[]) {
  if (kind === "markdown" && files.length > MAX_MARKDOWN_FILES) return `最多选择 ${MAX_MARKDOWN_FILES} 个 Markdown 文件。`;
  const maxBytes = kind === "bundle" ? MAX_BUNDLE_BYTES : MAX_IMPORT_BYTES;
  if (kind !== "urls" && files.reduce((total, file) => total + file.size, 0) > maxBytes) {
    return kind === "bundle" ? "织页知识包不能超过 100 MiB。" : "导入文件合计不能超过 10 MiB。";
  }
  return "";
}

function acceptedImportFiles(kind: ImportKind, selected: File[]) {
  if (kind === "markdown") return selected.filter((file) => /\.(?:md|markdown)$/iu.test(file.name));
  if (kind === "bundle") return selected.filter((file) => /\.zip$/iu.test(file.name)).slice(0, 1);
  if (kind === "bookmarks") return selected.filter((file) => /\.html?$/iu.test(file.name)).slice(0, 1);
  return [];
}

function unsupportedImportFileMessage(kind: ImportKind) {
  if (kind === "bundle") return "请选择 .zip 格式的织页知识包。";
  if (kind === "bookmarks") return "请选择 bookmarks.html。";
  return "没有找到 Markdown 文件。";
}

function normalizeCaptureUrl(value: string) {
  const parsed = new URL(value.trim());
  if (!/^https?:$/u.test(parsed.protocol)) throw new Error("INVALID_URL");
  return parsed.href;
}

function draftOf(document: KnowledgeDocument): Draft {
  return { title: document.title, markdown: document.markdown, tags: document.tags };
}

function draftsEqual(a: Draft, b: Draft) {
  return a.title.trim() === b.title.trim() && a.markdown === b.markdown && a.tags.join("\0") === b.tags.join("\0");
}

function sourceMetadataOf(document: KnowledgeDocument): SourceMetadataDraft {
  return {
    author: document.author || "",
    publishedDate: document.publishedAt ? document.publishedAt.slice(0, 10) : "",
    sourceNote: document.sourceNote,
  };
}

function sourceMetadataEqual(a: SourceMetadataDraft, document: KnowledgeDocument) {
  const current = sourceMetadataOf(document);
  return (
    a.author.trim() === current.author.trim() &&
    a.publishedDate === current.publishedDate &&
    a.sourceNote === current.sourceNote
  );
}

function sourceMetadataPatch(value: SourceMetadataDraft, document: KnowledgeDocument) {
  const patch: Omit<DocumentPatch, "revision"> = {};
  const author = value.author.trim() || null;
  if (author !== document.author) patch.author = author;
  const currentPublishedDate = document.publishedAt ? document.publishedAt.slice(0, 10) : "";
  if (value.publishedDate !== currentPublishedDate) {
    patch.publishedAt = value.publishedDate || null;
  }
  if (value.sourceNote !== document.sourceNote) patch.sourceNote = value.sourceNote;
  return patch;
}

function formatDate(value: string) {
  try {
    return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric" }).format(
      new Date(value),
    );
  } catch {
    return value;
  }
}

function formatDateTime(value: string) {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function sourceName(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "网页来源";
  }
}

function parseTags(value: string) {
  return [...new Set(value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean))];
}

function revisionPreview(markdown: string) {
  return markdown.replace(/[#*_`>\[\]()~-]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 150) || "空白正文";
}

function Icon({ children, size = 18 }: { children: ReactNode; size?: number }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

function StatePanel({ kind, title, children }: { kind: "loading" | "empty" | "error"; title: string; children?: ReactNode }) {
  return (
    <div className={`state-panel state-${kind}`} role={kind === "error" ? "alert" : undefined}>
      <div className="state-glyph" aria-hidden="true">{kind === "loading" ? <Spinner /> : kind === "error" ? "!" : "◌"}</div>
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}

function DocumentStatus({ status }: { status: CaptureStatus }) {
  return <span className={`status status-${status}`}><i />{STATUS_LABEL[status]}</span>;
}

function needsCapturePolling(document: Pick<DocumentSummary, "status" | "deletedAt">) {
  return ACTIVE_STATUSES.has(document.status) && !(document.deletedAt && document.status === "queued");
}

function resolveLink(href: string | undefined, sourceUrl: string) {
  if (!href) return undefined;
  if (href.startsWith("#") || href.startsWith("mailto:")) return href;
  try {
    const resolved = new URL(href, sourceUrl);
    return resolved.protocol === "http:" || resolved.protocol === "https:" ? resolved.href : undefined;
  } catch {
    return undefined;
  }
}

function assetSource(src: string | undefined, sourceUrl: string) {
  if (!src) return null;
  try {
    const resolved = new URL(src, sourceUrl);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
    resolved.hash = "";
    return resolved.href;
  } catch {
    return null;
  }
}

function ImagePlaceholder({ alt, children }: { alt?: string; children: string }) {
  const label = alt ? `图片“${alt}”` : "图片";
  return (
    <span className="external-image-note" role="img" aria-label={`${label}：${children}`}>
      <strong>{children}</strong>
      {alt && <small>{alt}</small>}
    </span>
  );
}

function OfflineImage({ asset, alt }: { asset?: DocumentAsset; alt?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [asset?.assetHash]);

  if (!asset) return <ImagePlaceholder alt={alt}>图片未离线保存，不会连接原站。</ImagePlaceholder>;
  if (asset.status === "queued" || asset.status === "fetching") {
    return <ImagePlaceholder alt={alt}>图片正在保存到本地。</ImagePlaceholder>;
  }
  if (asset.status === "failed") {
    return <ImagePlaceholder alt={alt}>{`图片离线保存失败${asset.errorMessage ? `：${asset.errorMessage}` : asset.errorCode ? `：${asset.errorCode}` : "。"}`}</ImagePlaceholder>;
  }
  if (!asset.assetHash || failed) {
    return <ImagePlaceholder alt={alt}>{failed ? "本地图片无法读取，不会回退到原站。" : "离线图片记录不完整。"}</ImagePlaceholder>;
  }
  return (
    <span className="offline-image">
      <img src={api.assetUrl(asset.assetHash)} alt={alt || ""} loading="lazy" onError={() => setFailed(true)} />
    </span>
  );
}

function MarkdownPreview({ markdown, sourceUrl, assets = [] }: { markdown: string; sourceUrl: string; assets?: DocumentAsset[] }) {
  const assetsBySource = useMemo(() => {
    const result = new Map<string, DocumentAsset>();
    for (const asset of assets) {
      const source = assetSource(asset.sourceUrl, sourceUrl);
      if (source) result.set(source, asset);
    }
    return result;
  }, [assets, sourceUrl]);

  return (
    <article className="markdown-preview">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, href, children, ...props }) => {
            const safeHref = resolveLink(href, sourceUrl);
            if (!safeHref) return <span>{children}</span>;
            const external = !safeHref.startsWith("#");
            return <a {...props} href={safeHref} target={external ? "_blank" : undefined} rel={external ? "noreferrer noopener" : undefined}>{children}</a>;
          },
          img: ({ node: _node, src, alt }) => {
            const source = assetSource(src, sourceUrl);
            return source
              ? <OfflineImage asset={assetsBySource.get(source)} alt={alt} />
              : <ImagePlaceholder alt={alt}>图片地址不可用。</ImagePlaceholder>;
          },
        }}
      >
        {markdown}
      </ReactMarkdown>
    </article>
  );
}

function captureDuration(value: number | null) {
  if (value === null) return "未完成";
  if (value < 1000) return `${value} ms`;
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} s`;
}

function CaptureHistoryPanel({
  document,
  blockedReason,
  onClose,
  onApply,
}: {
  document: KnowledgeDocument;
  blockedReason: string | null;
  onClose: () => void;
  onApply: (preview: ReextractionPreview, applyTitle: boolean, applyMarkdown: boolean) => Promise<void>;
}) {
  const [captures, setCaptures] = useState<CaptureHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reextracting, setReextracting] = useState("");
  const [applying, setApplying] = useState(false);
  const [preview, setPreview] = useState<ReextractionPreview | null>(null);
  const [applyTitle, setApplyTitle] = useState(false);
  const [applyMarkdown, setApplyMarkdown] = useState(false);
  const previewHeading = useRef<HTMLHeadingElement>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    try {
      setCaptures(await api.listCaptureHistory(document.id, signal));
    } catch (cause) {
      if ((cause as Error).name !== "AbortError") setError((cause as Error).message);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [document.id, document.status]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const reextract = async (capture: CaptureHistoryItem) => {
    setReextracting(capture.id);
    setError("");
    setNotice("");
    try {
      const next = await api.reextractCapture(document.id, capture.id);
      setPreview(next);
      setApplyTitle(false);
      setApplyMarkdown(false);
      setNotice("已从本地 HTML 快照生成候选，尚未修改正文。");
      requestAnimationFrame(() => previewHeading.current?.focus());
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setReextracting("");
    }
  };

  const apply = async () => {
    if (!preview || (!applyTitle && !applyMarkdown)) return;
    setApplying(true);
    setError("");
    setNotice("");
    try {
      await onApply(preview, applyTitle, applyMarkdown);
      setPreview(null);
      setNotice("已采纳选中内容，原修订仍保留在历史中。");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setApplying(false);
    }
  };

  const titleChanged = Boolean(preview && preview.before.title.trim() !== preview.after.title.trim());
  const markdownChanged = Boolean(preview && preview.before.markdown !== preview.after.markdown);

  return (
    <aside id="capture-history" className="revision-panel capture-history-panel" aria-label="采集历史">
      <header>
        <div><span className="eyebrow">SOURCE LEDGER</span><h3>采集历史</h3></div>
        <button type="button" onClick={onClose} aria-label="关闭采集历史">×</button>
      </header>

      {(error || notice) && <div className={`capture-ledger-message ${error ? "is-error" : "is-notice"}`} role={error ? "alert" : "status"}>{error || notice}</div>}

      {preview && (
        <section className="reextract-preview" aria-labelledby="reextract-title">
          <div className="reextract-head">
            <div><span className="eyebrow">LOCAL SNAPSHOT · {preview.extractorVersion}</span><h4 id="reextract-title" ref={previewHeading} tabIndex={-1}>重新提取候选</h4></div>
            <time dateTime={preview.createdAt}>{formatDateTime(preview.createdAt)}</time>
          </div>
          <div className="reextract-grid">
            <article><span>当前内容</span><strong>{preview.before.title || "未命名网页"}</strong><pre>{preview.before.markdown || "空白正文"}</pre></article>
            <article><span>快照候选</span><strong>{preview.after.title || "未命名网页"}</strong><pre>{preview.after.markdown || "空白正文"}</pre></article>
          </div>
          <fieldset disabled={applying || Boolean(blockedReason)}>
            <legend>只采纳你明确选中的部分</legend>
            <label><input type="checkbox" checked={applyTitle} onChange={(event) => setApplyTitle(event.target.checked)} disabled={!titleChanged} />替换标题 {!titleChanged && <small>无变化</small>}</label>
            <label><input type="checkbox" checked={applyMarkdown} onChange={(event) => setApplyMarkdown(event.target.checked)} disabled={!markdownChanged} />替换 Markdown 正文 {!markdownChanged && <small>无变化</small>}</label>
            <button type="button" className="primary-button" onClick={() => void apply()} disabled={!applyTitle && !applyMarkdown}>{applying ? "采纳中…" : "采纳选中内容"}</button>
          </fieldset>
          {blockedReason && <p className="reextract-blocked" role="note">{blockedReason}</p>}
        </section>
      )}

      {loading ? <StatePanel kind="loading" title="正在翻阅采集记录" /> : error && !captures.length ? <div className="capture-load-error"><StatePanel kind="error" title="无法读取采集历史">{error}</StatePanel><button type="button" onClick={() => void load()}>重试</button></div> : !captures.length ? <StatePanel kind="empty" title="还没有采集记录">网页开始读取后，每次尝试都会出现在这里。</StatePanel> : (
        <ol className="capture-ledger">
          {captures.map((capture) => {
            const source = resolveLink(capture.finalUrl || capture.requestUrl || undefined, document.sourceUrl);
            const snapshotLabel = capture.snapshotStored === "available" ? "HTML 快照可用" : capture.snapshotStored === "missing" ? "HTML 快照缺失" : "无 HTML 快照";
            return (
              <li key={capture.id}>
                <div className="capture-ledger-main">
                  <div><DocumentStatus status={capture.status} /><time dateTime={capture.startedAt}>{formatDateTime(capture.startedAt)}</time></div>
                  <strong>{capture.mode === "browser" ? "浏览器采集" : capture.mode === "http" ? "直接读取" : "未进入提取"}</strong>
                  <p>{source ? <a href={source} target="_blank" rel="noreferrer noopener">{source}</a> : "未记录最终地址"}</p>
                  {capture.warning && <p className="capture-ledger-warning">警告 · {capture.warning}</p>}
                  {(capture.errorCode || capture.errorMessage) && <p className="capture-ledger-error">{capture.errorCode || "CAPTURE_FAILED"} · {capture.errorMessage || "采集失败"}</p>}
                </div>
                <dl><div><dt>耗时</dt><dd>{captureDuration(capture.durationMs)}</dd></div><div><dt>HTTP</dt><dd>{capture.httpStatus ?? "—"}</dd></div><div><dt>提取器</dt><dd>{capture.extractorVersion || "旧版"}</dd></div><div><dt>快照</dt><dd>{snapshotLabel}</dd></div></dl>
                <button type="button" onClick={() => void reextract(capture)} disabled={capture.snapshotStored !== "available" || Boolean(reextracting) || applying || Boolean(document.deletedAt)} title={capture.snapshotStored !== "available" ? snapshotLabel : document.deletedAt ? "恢复文档后可重新提取" : undefined}>{reextracting === capture.id ? "提取中…" : "从快照重新提取"}</button>
              </li>
            );
          })}
        </ol>
      )}
    </aside>
  );
}

export default function App() {
  const [items, setItems] = useState<DocumentSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(30);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [searchScope, setSearchScope] = useState<SearchScope>("all");
  const [tag, setTag] = useState("");
  const [collectionFilter, setCollectionFilter] = useState("");
  const [status, setStatus] = useState<StatusFilter>("");
  const [favoriteFilter, setFavoriteFilter] = useState<boolean | undefined>();
  const [archivedFilter, setArchivedFilter] = useState<boolean | undefined>();
  const [captureModeFilter, setCaptureModeFilter] = useState<CaptureMode | "">("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [sortOrder, setSortOrder] = useState<SortOrder>("updated");
  const [unorganizedFilter, setUnorganizedFilter] = useState(false);
  const [libraryView, setLibraryView] = useState<LibraryView>("all");
  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>([]);
  const [recentFilterNotice, setRecentFilterNotice] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [batchAction, setBatchAction] = useState<BatchDocumentAction | "">("");
  const [batchCollectionId, setBatchCollectionId] = useState("");
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchNotice, setBatchNotice] = useState("");
  const [batchError, setBatchError] = useState("");
  const [portableExporting, setPortableExporting] = useState<"selected" | "all" | null>(null);
  const [portableNotice, setPortableNotice] = useState("");
  const [portableError, setPortableError] = useState("");
  const [listRefresh, setListRefresh] = useState(0);
  const [shortcutHelp, setShortcutHelp] = useState(false);
  const [inTrash, setInTrash] = useState(false);
  const [knownTags, setKnownTags] = useState<string[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState("");

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [currentDoc, setCurrentDoc] = useState<KnowledgeDocument | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [tagText, setTagText] = useState("");
  const [sourceMetadata, setSourceMetadata] = useState<SourceMetadataDraft | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [assets, setAssets] = useState<DocumentAsset[]>([]);
  const [assetError, setAssetError] = useState("");
  const [mode, setMode] = useState<EditorMode>("split");
  const [longPreviewDocumentId, setLongPreviewDocumentId] = useState<string | null>(null);

  const [importUrl, setImportUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const [importNotice, setImportNotice] = useState("");
  const [importDuplicate, setImportDuplicate] = useState<ImportDuplicatePrompt | null>(null);
  const [bulkImportOpen, setBulkImportOpen] = useState(false);
  const [bulkImportKind, setBulkImportKind] = useState<ImportKind>("urls");
  const [bulkImportText, setBulkImportText] = useState("");
  const [bulkImportFiles, setBulkImportFiles] = useState<File[]>([]);
  const [bulkImportPreview, setBulkImportPreview] = useState<ImportPreview | null>(null);
  const [bulkImportResult, setBulkImportResult] = useState<ImportApplyResult | null>(null);
  const [bulkImportStrategy, setBulkImportStrategy] = useState<ImportStrategy>("skip");
  const [bulkImportBusy, setBulkImportBusy] = useState(false);
  const [bulkImportError, setBulkImportError] = useState("");
  const [bulkImportNotice, setBulkImportNotice] = useState("");
  const [bulkImportTask, setBulkImportTask] = useState<"validating" | "importing" | null>(null);
  const [captureQueue, setCaptureQueue] = useState<CaptureQueueStatus | null>(null);
  const [queueError, setQueueError] = useState("");
  const [queueUpdating, setQueueUpdating] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState("");
  const [draftNotice, setDraftNotice] = useState("");
  const [draftError, setDraftError] = useState("");
  const [conflict, setConflict] = useState<KnowledgeDocument | null>(null);
  const [remoteDraftConflict, setRemoteDraftConflict] = useState<RemoteDraftConflict | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [resolvedDuplicate, setResolvedDuplicate] = useState<DocumentSummary | null>(null);
  const [duplicateError, setDuplicateError] = useState("");
  const [duplicateNotice, setDuplicateNotice] = useState("");
  const [lifecycleAction, setLifecycleAction] = useState<"delete" | "restore" | "permanent" | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [revisions, setRevisions] = useState<DocumentRevision[]>([]);
  const [restoringRevision, setRestoringRevision] = useState<number | null>(null);
  const [captureHistoryOpen, setCaptureHistoryOpen] = useState(false);
  const [qualityOpen, setQualityOpen] = useState(false);
  const [captureApplying, setCaptureApplying] = useState(false);
  const [closing, setClosing] = useState(false);
  const [safetyOpen, setSafetyOpen] = useState(false);
  const [safetyRecovery, setSafetyRecovery] = useState(false);
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  const [derivedOpen, setDerivedOpen] = useState(false);
  const [collections, setCollections] = useState<KnowledgeCollection[]>([]);
  const [collectionsOpen, setCollectionsOpen] = useState(false);
  const [collectionsLoading, setCollectionsLoading] = useState(false);
  const [collectionName, setCollectionName] = useState("");
  const [renamingCollection, setRenamingCollection] = useState<{ id: string; name: string } | null>(null);
  const [collectionAction, setCollectionAction] = useState<string | null>(null);
  const [managedTags, setManagedTags] = useState<KnowledgeTag[]>([]);
  const [tagAction, setTagAction] = useState<string | null>(null);
  const [organizationSaving, setOrganizationSaving] = useState(false);
  const [organizationError, setOrganizationError] = useState("");
  const [organizationNotice, setOrganizationNotice] = useState("");
  const [organizationConflict, setOrganizationConflict] = useState<OrganizationConflict | null>(null);

  const selectedIdRef = useRef(selectedId);
  const draftRef = useRef(draft);
  const currentDocRef = useRef(currentDoc);
  const sourceMetadataRef = useRef(sourceMetadata);
  const persistedDraftRef = useRef<DocumentDraft | null>(null);
  const draftSaveChain = useRef<Promise<void>>(Promise.resolve());
  const draftSyncPendingRef = useRef(0);
  const closeAttemptRef = useRef<string | null>(null);
  const saveInFlight = useRef(false);
  const organizationInFlight = useRef(false);
  const organizationPromiseRef = useRef<Promise<unknown> | null>(null);
  const organizationConflictRef = useRef<OrganizationConflict | null>(null);
  const selectionContextRef = useRef<string | null>(null);
  const listContextRef = useRef("");
  const itemsContextRef = useRef("");
  const savedFiltersEditedRef = useRef(false);
  const recentFiltersStateRef = useRef<{ filters: SavedFilter[]; revision: number }>({ filters: [], revision: 0 });
  const recentFilterSaveChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const shortcutDialogRef = useRef<HTMLDialogElement>(null);
  const bulkImportDialogRef = useRef<HTMLDialogElement>(null);
  const bulkImportAbortRef = useRef<AbortController | null>(null);
  const externalIntentHandlerRef = useRef<(intents: ExternalIntent[]) => Promise<void>>(async () => undefined);
  const portableExportAbortRef = useRef<AbortController | null>(null);
  const collectionsRequestRef = useRef<{ sequence: number; controller: AbortController } | null>(null);
  const collectionsRequestSequenceRef = useRef(0);
  const keptDuplicateIdsRef = useRef(new Set<string>());
  const navigationGenerationRef = useRef(0);
  const readerPanelRef = useRef<HTMLElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const libraryListRef = useRef<HTMLDivElement>(null);
  selectedIdRef.current = selectedId;
  draftRef.current = draft;
  currentDocRef.current = currentDoc;
  sourceMetadataRef.current = sourceMetadata;
  const listContextKey = JSON.stringify([
    query, searchScope, tag, collectionFilter, status, favoriteFilter, archivedFilter,
    unorganizedFilter, captureModeFilter, dateFrom, dateTo, sortOrder, inTrash, page,
  ]);
  listContextRef.current = listContextKey;

  const updateOrganizationConflict = useCallback((value: OrganizationConflict | null) => {
    organizationConflictRef.current = value;
    setOrganizationConflict(value);
  }, []);

  useEffect(() => {
    void api.getDataSafety().then((value) => {
      if (value.mode === "recovery") {
        setSafetyRecovery(true);
        setSafetyOpen(true);
      }
    }).catch(() => undefined);
  }, []);

  useEffect(() => setDerivedOpen(false), [selectedId]);

  useEffect(() => {
    recentFilterSaveChainRef.current = api.getRecentFilters().then((value) => {
      recentFiltersStateRef.current = value;
      if (!savedFiltersEditedRef.current) setSavedFilters(value.filters);
    }).catch(() => undefined);
  }, []);

  const longArticle = (draft?.markdown.length ?? 0) > 250_000;
  const longPreviewAllowed = !longArticle || longPreviewDocumentId === currentDoc?.id;
  useEffect(() => {
    if (longArticle) setMode("edit");
    else setLongPreviewDocumentId(null);
  }, [longArticle]);

  useEffect(() => {
    const dialog = shortcutDialogRef.current;
    if (!dialog || !shortcutHelp) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      previousFocus?.focus();
    };
  }, [shortcutHelp]);

  useEffect(() => {
    const dialog = bulkImportDialogRef.current;
    if (!dialog || !bulkImportOpen) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      previousFocus?.focus();
    };
  }, [bulkImportOpen]);

  useEffect(() => () => {
    bulkImportAbortRef.current?.abort();
    portableExportAbortRef.current?.abort();
  }, []);

  const persistedDraft = currentDoc ? draftOf(currentDoc) : null;
  const dirty = Boolean(draft && persistedDraft && !draftsEqual(draft, persistedDraft));
  const metadataDirty = Boolean(sourceMetadata && currentDoc && !sourceMetadataEqual(sourceMetadata, currentDoc));
  const hasUnsavedChanges = dirty || metadataDirty;
  const activeCapture = currentDoc ? ACTIVE_STATUSES.has(currentDoc.status) : false;
  const editorLocked = closing || captureApplying || organizationSaving || batchBusy || Boolean(collectionAction) || Boolean(tagAction) || metadataDirty || Boolean(organizationConflict) || Boolean(lifecycleAction) || restoringRevision !== null || Boolean(conflict && saveState === "saving");
  const organizationLocked = (
    closing || captureApplying || organizationSaving || batchBusy || Boolean(collectionAction) || Boolean(tagAction) || dirty || saveState === "saving" ||
    Boolean(conflict) || Boolean(remoteDraftConflict) || Boolean(organizationConflict) ||
    Boolean(lifecycleAction) || restoringRevision !== null || Boolean(currentDoc?.deletedAt) || currentDoc?.status !== "ready"
  );
  const navigationMutationLocked = Boolean(lifecycleAction) || restoringRevision !== null;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const bulkImportReady = bulkImportKind === "urls" ? Boolean(bulkImportText.trim()) : bulkImportFiles.length > 0;
  const bulkResultById = useMemo(() => new Map(bulkImportResult?.items.map((item) => [item.id, item]) || []), [bulkImportResult]);
  const bulkImportTouchesDirtyDocument = Boolean(
    bulkImportStrategy === "update" && hasUnsavedChanges && currentDoc &&
    bulkImportPreview?.items.some((item) => item.existingDocumentId === currentDoc.id),
  );

  const loadCaptureQueue = useCallback(async (signal?: AbortSignal) => {
    try {
      setCaptureQueue(await api.getCaptureQueue(signal));
      setQueueError("");
    } catch (error) {
      if ((error as Error).name !== "AbortError") setQueueError((error as Error).message);
    }
  }, []);

  useEffect(() => {
    if (safetyOpen) return;
    const controller = new AbortController();
    void loadCaptureQueue(controller.signal);
    return () => controller.abort();
  }, [loadCaptureQueue, safetyOpen]);

  useEffect(() => {
    if (safetyOpen || !captureQueue || (!captureQueue.active && !captureQueue.queued)) return;
    const timer = window.setInterval(() => void loadCaptureQueue(), 1800);
    return () => window.clearInterval(timer);
  }, [captureQueue?.active, captureQueue?.queued, loadCaptureQueue, safetyOpen]);

  const invalidateCollectionsLoad = useCallback(() => {
    collectionsRequestSequenceRef.current += 1;
    collectionsRequestRef.current?.controller.abort();
    collectionsRequestRef.current = null;
    setCollectionsLoading(false);
  }, []);

  const loadCollections = useCallback(async (signal?: AbortSignal) => {
    const sequence = ++collectionsRequestSequenceRef.current;
    collectionsRequestRef.current?.controller.abort();
    const controller = new AbortController();
    collectionsRequestRef.current = { sequence, controller };
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", abort, { once: true });
    setCollectionsLoading(true);
    try {
      const result = await api.listCollections(controller.signal);
      if (collectionsRequestSequenceRef.current === sequence && !controller.signal.aborted) {
        setCollections(result);
      }
    } catch (error) {
      if ((error as Error).name !== "AbortError" && collectionsRequestSequenceRef.current === sequence) {
        setOrganizationError((error as Error).message);
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      if (collectionsRequestRef.current?.sequence === sequence) {
        collectionsRequestRef.current = null;
        setCollectionsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (safetyOpen) return;
    const controller = new AbortController();
    void loadCollections(controller.signal);
    return () => controller.abort();
  }, [loadCollections, safetyOpen]);

  const refreshKnownTags = useCallback((signal?: AbortSignal) => {
    void api.listTags(inTrash ? "only" : undefined, signal).then(setKnownTags).catch(() => {
      // Keep the last complete tag list when this secondary refresh fails.
    });
  }, [inTrash]);

  const updateListItem = useCallback((document: KnowledgeDocument) => {
    setItems((previous) => previous.map((item) => item.id === document.id ? {
      ...item,
      title: document.title,
      tags: document.tags,
      status: document.status,
      warning: document.warning,
      errorCode: document.errorCode,
      errorMessage: document.errorMessage,
      revision: document.revision,
      deletedAt: document.deletedAt,
      favorite: document.favorite,
      archivedAt: document.archivedAt,
      collections: document.collections,
      updatedAt: document.updatedAt,
    } : item));
  }, []);

  const installCurrentDocument = useCallback((document: KnowledgeDocument | null) => {
    const metadata = document ? sourceMetadataOf(document) : null;
    currentDocRef.current = document;
    sourceMetadataRef.current = metadata;
    setCurrentDoc(document);
    setSourceMetadata(metadata);
  }, []);

  const trackOrganizationTask = useCallback(function track<T>(request: Promise<T>) {
    organizationInFlight.current = true;
    organizationPromiseRef.current = request;
    return request.finally(() => {
      if (organizationPromiseRef.current === request) {
        organizationPromiseRef.current = null;
        organizationInFlight.current = false;
      }
    });
  }, []);

  const sendOrganizationPatch = useCallback((document: KnowledgeDocument, patch: Omit<DocumentPatch, "revision">) => (
    api.updateDocument(document.id, { ...patch, revision: document.revision })
  ), []);

  const focusReader = useCallback(() => {
    window.requestAnimationFrame(() => readerPanelRef.current?.focus());
  }, []);

  const currentDirtyDraft = () => {
    const document = currentDocRef.current;
    const value = draftRef.current;
    if (!document || !value || draftsEqual(value, draftOf(document))) return null;
    return { documentId: document.id, draft: { ...value, tags: [...value.tags] } };
  };

  const currentDirtySourceMetadata = () => {
    const document = currentDocRef.current;
    const value = sourceMetadataRef.current;
    if (!document || !value || sourceMetadataEqual(value, document)) return null;
    return { documentId: document.id, draft: { ...value } };
  };

  const beginNavigation = (): NavigationGuard => ({
    generation: ++navigationGenerationRef.current,
    selectedId: selectedIdRef.current,
    dirty: currentDirtyDraft(),
    metadata: currentDirtySourceMetadata(),
  });

  const canApplyNavigation = (guard: NavigationGuard) => {
    if (navigationGenerationRef.current !== guard.generation || selectedIdRef.current !== guard.selectedId) return false;
    const liveDraft = currentDirtyDraft();
    const sameDraft = !liveDraft || Boolean(
      guard.dirty && guard.dirty.documentId === liveDraft.documentId && draftsEqual(guard.dirty.draft, liveDraft.draft)
    );
    const liveMetadata = currentDirtySourceMetadata();
    const sameMetadata = !liveMetadata || Boolean(
      guard.metadata && guard.metadata.documentId === liveMetadata.documentId &&
      guard.metadata.draft.author === liveMetadata.draft.author &&
      guard.metadata.draft.publishedDate === liveMetadata.draft.publishedDate &&
      guard.metadata.draft.sourceNote === liveMetadata.draft.sourceNote
    );
    return sameDraft && sameMetadata;
  };

  const invalidateNavigation = () => {
    navigationGenerationRef.current += 1;
  };

  const enqueueDraftSync = useCallback((work: () => Promise<void>) => {
    draftSyncPendingRef.current += 1;
    const task = draftSaveChain.current.then(async () => {
      try {
        await work();
      } finally {
        draftSyncPendingRef.current -= 1;
      }
    });
    draftSaveChain.current = task.catch(() => undefined);
    return task;
  }, []);

  const reportDraftConflict = useCallback((documentId: string, error: unknown) => {
    if (!(error instanceof ApiRequestError) || error.code !== "DRAFT_CONFLICT") return false;
    if (selectedIdRef.current === documentId) {
      setRemoteDraftConflict({ remote: error.draft ?? null });
      setDraftError("草稿已在另一窗口发生变化，你的当前编辑仍保留在本窗口。");
      setSaveState("conflict");
    }
    return true;
  }, []);

  const persistDraft = useCallback((
    document: KnowledgeDocument,
    value: Draft,
    expectedDraftRevision?: number | null,
  ) => {
    const snapshot = { title: value.title, markdown: value.markdown, tags: [...value.tags] };
    return enqueueDraftSync(async () => {
      const known = persistedDraftRef.current;
      const expected = expectedDraftRevision === undefined
        ? known?.documentId === document.id ? known.draftRevision : null
        : expectedDraftRevision;
      let stored: DocumentDraft;
      try {
        stored = await api.saveDocumentDraft(document.id, {
          expectedDraftRevision: expected,
          baseRevision: document.revision,
          ...snapshot,
        });
      } catch (error) {
        reportDraftConflict(document.id, error);
        throw error;
      }
      if (selectedIdRef.current === document.id) {
        persistedDraftRef.current = stored;
        const latestDocument = currentDocRef.current;
        const latestValue = draftRef.current;
        if (
          latestDocument?.id === document.id && latestValue &&
          draftsEqual(latestValue, draftOf(latestDocument))
        ) {
          try {
            await api.deleteDocumentDraft(document.id, stored.draftRevision);
          } catch (error) {
            reportDraftConflict(document.id, error);
            throw error;
          }
          if (persistedDraftRef.current?.draftRevision === stored.draftRevision) {
            persistedDraftRef.current = null;
          }
        }
        setDraftError("");
      }
    });
  }, [enqueueDraftSync, reportDraftConflict]);

  const tombstoneDraft = useCallback((documentId: string, expectedDraftRevision?: number) => {
    return enqueueDraftSync(async () => {
      const known = persistedDraftRef.current;
      const expected = expectedDraftRevision ?? (
        known?.documentId === documentId ? known.draftRevision : undefined
      );
      if (expected === undefined) return;
      try {
        await api.deleteDocumentDraft(documentId, expected);
      } catch (error) {
        reportDraftConflict(documentId, error);
        throw error;
      }
      if (
        selectedIdRef.current === documentId &&
        persistedDraftRef.current?.documentId === documentId &&
        persistedDraftRef.current.draftRevision === expected
      ) {
        persistedDraftRef.current = null;
        setDraftError("");
      }
    });
  }, [enqueueDraftSync, reportDraftConflict]);

  const prepareDataSafetyOperation = useCallback(async () => {
    if (closeAttemptRef.current) throw new Error("应用正在关闭，请重新打开后再操作。");
    if (remoteDraftConflict) throw new Error("请先处理当前草稿冲突。");
    if (currentDirtySourceMetadata() || organizationInFlight.current || organizationConflict) {
      throw new Error("请先保存或放弃当前来源信息。");
    }
    await draftSaveChain.current;
    const document = currentDocRef.current;
    const value = draftRef.current;
    if (!document || !value || document.status !== "ready") return;
    if (draftsEqual(value, draftOf(document))) await tombstoneDraft(document.id);
    else await persistDraft(document, value);
    await draftSaveChain.current;
  }, [organizationConflict, persistDraft, remoteDraftConflict, tombstoneDraft]);

  const reloadDraftConflict = useCallback(async (documentId: string) => {
    const [document, stored] = await Promise.all([
      api.getDocument(documentId),
      api.getDocumentDraft(documentId),
    ]);
    if (selectedIdRef.current !== documentId) return;
    installCurrentDocument(document);
    updateListItem(document);
    setRemoteDraftConflict({ remote: stored });
    setSaveState("conflict");
    setDraftNotice("检测到另一个窗口写入的草稿，你的当前编辑未被覆盖。");
  }, [installCurrentDocument, updateListItem]);

  useEffect(() => {
    const controller = new AbortController();
    itemsContextRef.current = "";
    selectionContextRef.current = null;
    setSelectedIds(new Set());
    const timer = window.setTimeout(async () => {
      setListLoading(true);
      setListError("");
      try {
        const result = await api.listDocuments(
          {
            q: query,
            scope: searchScope,
            tag,
            collectionId: collectionFilter,
            status,
            favorite: favoriteFilter,
            archived: archivedFilter,
            unorganized: unorganizedFilter || undefined,
            captureMode: captureModeFilter || undefined,
            from: dateFrom,
            to: dateTo,
            sort: sortOrder,
            page,
            trash: inTrash ? "only" : undefined,
          },
          controller.signal,
        );
        const lastPage = Math.max(1, Math.ceil(result.total / (result.pageSize || 30)));
        if (page > lastPage) {
          setPage(lastPage);
          return;
        }
        itemsContextRef.current = listContextKey;
        setItems(result.items);
        setTotal(result.total);
        setPageSize(result.pageSize || 30);
        refreshKnownTags(controller.signal);
      } catch (error) {
        if ((error as Error).name !== "AbortError") setListError((error as Error).message);
      } finally {
        if (!controller.signal.aborted) setListLoading(false);
      }
    }, query ? 220 : 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [archivedFilter, captureModeFilter, collectionFilter, dateFrom, dateTo, favoriteFilter, inTrash, listRefresh, page, query, refreshKnownTags, searchScope, sortOrder, status, tag, unorganizedFilter]);

  useEffect(() => {
    if (!items.some(needsCapturePolling)) return;
    const controller = new AbortController();
    const timer = window.setInterval(async () => {
      try {
        const result = await api.listDocuments({
          q: query,
          scope: searchScope,
          tag,
          collectionId: collectionFilter,
          status,
          favorite: favoriteFilter,
          archived: archivedFilter,
          unorganized: unorganizedFilter || undefined,
          captureMode: captureModeFilter || undefined,
          from: dateFrom,
          to: dateTo,
          sort: sortOrder,
          page,
          trash: inTrash ? "only" : undefined,
        }, controller.signal);
        if (controller.signal.aborted) return;
        const lastPage = Math.max(1, Math.ceil(result.total / (result.pageSize || 30)));
        if (page > lastPage) {
          setPage(lastPage);
          return;
        }
        itemsContextRef.current = listContextKey;
        setItems(result.items);
        setTotal(result.total);
        refreshKnownTags();
      } catch (error) {
        if ((error as Error).name === "AbortError") return;
        // Background refresh failures should not replace the current workspace.
      }
    }, 2500);
    return () => {
      window.clearInterval(timer);
      controller.abort();
    };
  }, [archivedFilter, captureModeFilter, collectionFilter, dateFrom, dateTo, favoriteFilter, inTrash, items, page, query, refreshKnownTags, searchScope, sortOrder, status, tag, unorganizedFilter]);

  useEffect(() => {
    setSelectedIds((previous) => new Set(items.filter((item) => previous.has(item.id)).map((item) => item.id)));
  }, [items]);

  useEffect(() => {
    selectionContextRef.current = null;
    setSelectedIds(new Set());
    setBatchAction("");
  }, [listContextKey]);

  useEffect(() => {
    setLibraryView((value) => inTrash ? "trash" : value === "trash" ? "all" : value);
  }, [inTrash]);

  useEffect(() => {
    if (inTrash || (!query.trim() && searchScope === "all" && !tag && !collectionFilter && !status && favoriteFilter === undefined && archivedFilter === undefined && !captureModeFilter && !dateFrom && !dateTo && sortOrder === "updated")) return;
    const timer = window.setTimeout(() => {
      savedFiltersEditedRef.current = true;
      const saved: SavedFilter = {
        label: [query.trim() && `“${query.trim()}”`, tag && `#${tag}`, collectionFilter && "集合", status && STATUS_LABEL[status], favoriteFilter && "收藏", archivedFilter && "归档", unorganizedFilter && "未整理"].filter(Boolean).join(" · ") || "组合筛选",
        query: query.trim(),
        scope: searchScope,
        tag,
        collectionId: collectionFilter,
        status,
        favorite: favoriteFilter,
        archived: archivedFilter,
        unorganized: unorganizedFilter,
        captureMode: captureModeFilter,
        from: dateFrom,
        to: dateTo,
        sort: sortOrder,
      };
      setSavedFilters((previous) => {
        const next = addRecentFilter(previous, saved);
        recentFilterSaveChainRef.current = recentFilterSaveChainRef.current
          .catch(() => undefined)
          .then(() => {
            const current = recentFiltersStateRef.current;
            return api.saveRecentFilters(addRecentFilter(current.filters, saved), current.revision);
          })
          .then((value) => {
            recentFiltersStateRef.current = value;
            setSavedFilters(value.filters);
          })
          .catch(async (error) => {
            if (!(error instanceof ApiRequestError) || error.code !== "RECENT_FILTERS_CONFLICT") throw error;
            const value = await api.getRecentFilters();
            recentFiltersStateRef.current = value;
            setSavedFilters(value.filters);
            setRecentFilterNotice("最近筛选已在另一窗口更新，已载入最新版本。");
          });
        return next;
      });
    }, 600);
    return () => window.clearTimeout(timer);
  }, [archivedFilter, captureModeFilter, collectionFilter, dateFrom, dateTo, favoriteFilter, inTrash, query, searchScope, sortOrder, status, tag, unorganizedFilter]);

  useEffect(() => {
    if (!selectedId) {
      installCurrentDocument(null);
      setDraft(null);
      setAssets([]);
      setAssetError("");
      return;
    }
    const controller = new AbortController();
    installCurrentDocument(null);
    setDraft(null);
    setAssets([]);
    setAssetError("");
    setTagText("");
    setDetailLoading(true);
    setDetailError("");
    setSaveState("idle");
    setSaveError("");
    setDraftNotice("");
    setDraftError("");
    setOrganizationError("");
    setOrganizationNotice("");
    updateOrganizationConflict(null);
    setCollectionsOpen(false);
    setRenamingCollection(null);
    persistedDraftRef.current = null;
    setConflict(null);
    setRemoteDraftConflict(null);
    setResolvedDuplicate(null);
    setDuplicateError("");
    setDuplicateNotice("");
    setHistoryOpen(false);
    setCaptureHistoryOpen(false);
    setQualityOpen(false);
    setHistoryLoading(false);
    setHistoryError("");
    setRevisions([]);
    setRestoringRevision(null);
    Promise.all([
      api.getDocument(selectedId, controller.signal),
      api.getDocumentDraft(selectedId, controller.signal),
    ])
      .then(([document, stored]) => {
        installCurrentDocument(document);
        if (document.markdown.length > 250_000) setMode("edit");
        const serverDraft = draftOf(document);
        const recovered = stored
          ? { title: stored.title, markdown: stored.markdown, tags: [...stored.tags] }
          : null;
        if (stored && recovered && !draftsEqual(recovered, serverDraft)) {
          persistedDraftRef.current = stored;
          setDraft(recovered);
          setTagText(recovered.tags.join(", "));
          setDraftNotice("已恢复上次未正式保存的本地草稿。");
          if (stored.baseRevision !== document.revision || document.deletedAt) {
            setConflict(document);
            setSaveState("conflict");
          }
        } else {
          persistedDraftRef.current = stored;
          setDraft(serverDraft);
          setTagText(document.tags.join(", "));
        }
      })
      .catch((error) => {
        if ((error as Error).name !== "AbortError") setDetailError((error as Error).message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailLoading(false);
      });
    return () => controller.abort();
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    const documentId = selectedId;
    const controller = new AbortController();
    void api.listDocumentAssets(documentId, controller.signal).then((result) => {
      if (selectedIdRef.current !== documentId) return;
      setAssets(result);
      setAssetError("");
    }).catch((error) => {
      if ((error as Error).name !== "AbortError" && selectedIdRef.current === documentId) {
        setAssetError((error as Error).message);
      }
    });
    return () => controller.abort();
  }, [currentDoc?.status, selectedId]);

  const activeAssetCapture = assets.some((asset) => asset.status === "queued" || asset.status === "fetching");

  useEffect(() => {
    if (!selectedId || !activeAssetCapture) return;
    const documentId = selectedId;
    const timer = window.setInterval(async () => {
      try {
        const result = await api.listDocumentAssets(documentId);
        if (selectedIdRef.current !== documentId) return;
        setAssets(result);
        setAssetError("");
      } catch (error) {
        if (selectedIdRef.current === documentId) setAssetError((error as Error).message);
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [activeAssetCapture, selectedId]);

  useEffect(() => {
    if (!selectedId || currentDoc?.status !== "ready" || currentDoc.deletedAt || keptDuplicateIdsRef.current.has(selectedId)) {
      setResolvedDuplicate(null);
      setDuplicateError("");
      return;
    }
    const documentId = selectedId;
    const controller = new AbortController();
    void api.getDocumentDuplicate(documentId, controller.signal).then((duplicate) => {
      if (selectedIdRef.current !== documentId) return;
      setResolvedDuplicate(duplicate);
      setDuplicateError("");
    }).catch((error) => {
      if ((error as Error).name !== "AbortError" && selectedIdRef.current === documentId) {
        setDuplicateError((error as Error).message);
      }
    });
    return () => controller.abort();
  }, [currentDoc?.deletedAt, currentDoc?.status, selectedId]);

  useEffect(() => {
    if (!selectedId || !currentDoc || !needsCapturePolling(currentDoc)) return;
    const documentId = selectedId;
    const controller = new AbortController();
    const timer = window.setInterval(async () => {
      try {
        const document = await api.getDocument(documentId, controller.signal);
        const live = currentDocRef.current;
        if (
          controller.signal.aborted || selectedIdRef.current !== documentId || !live || live.id !== documentId ||
          !needsCapturePolling(live)
        ) return;
        updateListItem(document);
        installCurrentDocument(document);
        setDraft(draftOf(document));
        setTagText(document.tags.join(", "));
      } catch (error) {
        if ((error as Error).name === "AbortError") return;
        // The list poll remains the visible source of capture progress.
      }
    }, 1800);
    return () => {
      window.clearInterval(timer);
      controller.abort();
    };
  }, [currentDoc?.id, currentDoc?.status, selectedId, updateListItem]);

  useEffect(() => {
    const stored = persistedDraftRef.current;
    if (
      closing || remoteDraftConflict || saveState === "saving" || !dirty || !currentDoc || !draft ||
      currentDoc.status !== "ready" ||
      currentDoc.deletedAt ||
      (stored?.documentId === currentDoc.id && draftsEqual(draft, stored))
    ) return;
    const document = currentDoc;
    const snapshot = { title: draft.title, markdown: draft.markdown, tags: [...draft.tags] };
    const timer = window.setTimeout(() => {
      void persistDraft(document, snapshot).catch((error) => {
        if (!(error instanceof ApiRequestError) || error.code !== "DRAFT_CONFLICT") {
          setDraftError((error as Error).message);
        }
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [closing, currentDoc, dirty, draft, persistDraft, remoteDraftConflict, saveState]);

  useEffect(() => {
    const stored = persistedDraftRef.current;
    if (
      closing || remoteDraftConflict || dirty || !currentDoc || !draft ||
      stored?.documentId !== currentDoc.id || !draftsEqual(draft, draftOf(currentDoc))
    ) return;
    void tombstoneDraft(currentDoc.id).catch((error) => {
      if (!(error instanceof ApiRequestError) || error.code !== "DRAFT_CONFLICT") {
        setDraftError((error as Error).message);
      }
    });
  }, [closing, currentDoc, dirty, draft, remoteDraftConflict, tombstoneDraft]);

  const saveNow = useCallback(async () => {
    if (
      closeAttemptRef.current || !currentDoc || !draft || currentDoc.status !== "ready" || !dirty ||
      saveInFlight.current || organizationInFlight.current || collectionAction || metadataDirty || organizationConflict ||
      conflict || remoteDraftConflict
    ) return;
    const sent = { ...draft, tags: [...draft.tags] };
    saveInFlight.current = true;
    setSaveState("saving");
    setSaveError("");
    try {
      await persistDraft(currentDoc, sent);
      const updated = await api.updateDocument(currentDoc.id, { ...sent, revision: currentDoc.revision });
      if (selectedIdRef.current !== currentDoc.id) return;
      installCurrentDocument(updated);
      updateListItem(updated);
      setListRefresh((value) => value + 1);
      refreshKnownTags();
      const unchangedSinceRequest = Boolean(draftRef.current && draftsEqual(draftRef.current, sent));
      if (unchangedSinceRequest) {
        persistedDraftRef.current = null;
        setDraft(draftOf(updated));
        setTagText(updated.tags.join(", "));
        setDraftNotice("");
      }
      setSaveState(unchangedSinceRequest ? "saved" : "idle");
    } catch (error) {
      if (selectedIdRef.current !== currentDoc.id) return;
      if (error instanceof ApiRequestError && error.code === "DRAFT_CONFLICT") {
        setSaveError(error.message);
        setSaveState("conflict");
      } else if (error instanceof ApiRequestError && error.status === 409 && error.document) {
        setConflict(error.document);
        setSaveState("conflict");
      } else {
        setSaveError((error as Error).message);
        setSaveState("error");
      }
    } finally {
      saveInFlight.current = false;
    }
  }, [collectionAction, conflict, currentDoc, dirty, draft, metadataDirty, organizationConflict, persistDraft, refreshKnownTags, remoteDraftConflict, updateListItem]);

  useEffect(() => {
    if (closing || !dirty || saveState === "conflict" || saveState === "error" || currentDoc?.status !== "ready") return;
    const timer = window.setTimeout(saveNow, 800);
    return () => window.clearTimeout(timer);
  }, [closing, currentDoc?.status, dirty, saveNow, saveState]);

  useEffect(() => {
    if (saveState !== "saved") return;
    const timer = window.setTimeout(() => setSaveState("idle"), 1600);
    return () => window.clearTimeout(timer);
  }, [saveState]);

  useEffect(() => {
    const handleSave = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveNow();
      }
    };
    window.addEventListener("keydown", handleSave);
    return () => window.removeEventListener("keydown", handleSave);
  }, [saveNow]);

  useEffect(() => {
    const warnUnsaved = (event: BeforeUnloadEvent) => {
      const document = currentDocRef.current;
      const value = draftRef.current;
      const stored = persistedDraftRef.current;
      const storedForDocument = Boolean(document && stored?.documentId === document.id);
      const contentIsDirty = Boolean(document && value && !draftsEqual(value, draftOf(document)));
      const safelyPersisted = contentIsDirty
        ? Boolean(value && storedForDocument && stored && draftsEqual(value, stored))
        : !storedForDocument || Boolean(document && stored && draftsEqual(stored, draftOf(document)));
      if (
        draftSyncPendingRef.current === 0 &&
        !currentDirtySourceMetadata() &&
        !organizationInFlight.current &&
        !organizationConflict &&
        !remoteDraftConflict &&
        safelyPersisted
      ) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnUnsaved);
    return () => window.removeEventListener("beforeunload", warnUnsaved);
  }, [organizationConflict, remoteDraftConflict]);

  useEffect(() => {
    const prepareClose = (event: Event) => {
      const attemptId = (event as CustomEvent<{ attemptId?: unknown }>).detail?.attemptId;
      if (typeof attemptId !== "string" || !/^[1-9]\d{0,19}$/u.test(attemptId)) {
        setDraftError("关闭请求缺少有效标识，请再次关闭窗口重试。");
        return;
      }
      if (closeAttemptRef.current) return;
      closeAttemptRef.current = attemptId;
      setClosing(true);
      void (async () => {
        try {
          if (organizationConflictRef.current) throw new Error("请先处理来源信息的版本冲突。");
          if (organizationPromiseRef.current) await organizationPromiseRef.current;
          if (organizationConflictRef.current) throw new Error("请先处理来源信息的版本冲突。");
          await draftSaveChain.current;
          if (closeAttemptRef.current !== attemptId) return;
          let document = currentDocRef.current;
          const value = draftRef.current;
          const metadata = sourceMetadataRef.current;
          if (!safetyRecovery && document && metadata && !sourceMetadataEqual(metadata, document)) {
            document = await trackOrganizationTask(
              sendOrganizationPatch(document, sourceMetadataPatch(metadata, document)),
            );
            installCurrentDocument(document);
            updateListItem(document);
          }
          if (!safetyRecovery && document && value) {
            const stored = persistedDraftRef.current;
            const alreadyDurable = stored?.documentId === document.id && draftsEqual(value, stored);
            if (draftsEqual(value, draftOf(document))) {
              if (!safetyOpen) await tombstoneDraft(document.id);
            } else if (!alreadyDurable) {
              await persistDraft(document, value);
            }
          }
          const stagedImportId = bulkImportPreview?.id ?? null;
          if (stagedImportId) {
            try {
              await api.cancelImport(stagedImportId, AbortSignal.timeout(400));
              setBulkImportPreview((preview) => preview?.id === stagedImportId ? null : preview);
            } catch {
              // Closing must never fail because temporary import cleanup failed.
            }
          }
          if (closeAttemptRef.current !== attemptId) return;
          await api.desktopCloseReady(attemptId);
        } catch (error) {
          if (closeAttemptRef.current !== attemptId) return;
          closeAttemptRef.current = null;
          setClosing(false);
          setDraftError(`关闭前无法保存更改：${(error as Error).message}`);
        }
      })();
    };
    const closeTimedOut = (event: Event) => {
      const attemptId = (event as CustomEvent<{ attemptId?: unknown }>).detail?.attemptId;
      if (attemptId !== closeAttemptRef.current) return;
      closeAttemptRef.current = null;
      setClosing(false);
      setDraftError("关闭确认超时，请再次关闭窗口重试。");
    };
    window.addEventListener("zhiye:close-requested", prepareClose);
    window.addEventListener("zhiye:close-timeout", closeTimedOut);
    return () => {
      window.removeEventListener("zhiye:close-requested", prepareClose);
      window.removeEventListener("zhiye:close-timeout", closeTimedOut);
    };
  }, [bulkImportPreview, installCurrentDocument, persistDraft, safetyOpen, safetyRecovery, sendOrganizationPatch, tombstoneDraft, trackOrganizationTask, updateListItem]);

  const revealDocument = async (document: DocumentSummary, guard: NavigationGuard) => {
    const inTargetTrash = Boolean(document.deletedAt);
    if (!canApplyNavigation(guard)) return false;
    itemsContextRef.current = "";
    selectionContextRef.current = null;
    setLibraryView(inTargetTrash ? "trash" : "all");
    setQuery("");
    setSearchScope("all");
    setTag("");
    setCollectionFilter("");
    setStatus("");
    setFavoriteFilter(undefined);
    setArchivedFilter(undefined);
    setUnorganizedFilter(false);
    setCaptureModeFilter("");
    setDateFrom("");
    setDateTo("");
    setSortOrder("updated");
    setPage(1);
    setInTrash(inTargetTrash);
    setItems([]);
    setSelectedIds(new Set());
    setListRefresh((value) => value + 1);
    setSelectedId(document.id);
    focusReader();
    return true;
  };

  const importDocument = async (url: string, force: boolean, guard: NavigationGuard) => {
    setImporting(true);
    setImportError("");
    setImportNotice("");
    try {
      const result = await api.createDocument(url, force);
      if (!canApplyNavigation(guard)) return;
      if (!result.created) {
        setImportDuplicate({
          document: result.document,
          kind: result.duplicateKind === "resolved" ? "resolved" : "source",
          url,
        });
        return;
      }
      setImportDuplicate(null);
      setImportUrl("");
      if (force) keptDuplicateIdsRef.current.add(result.document.id);
      if (!await revealDocument(result.document, guard)) return;
      setImportNotice(force ? "已保留为另一篇知识，两篇内容都不会被删除。" : "");
      void loadCaptureQueue();
    } catch (error) {
      if (canApplyNavigation(guard)) setImportError((error as Error).message);
    } finally {
      setImporting(false);
    }
  };

  const captureUrl = async (value: string) => {
    if (closeAttemptRef.current || lifecycleAction || restoringRevision !== null) return;
    setImportError("");
    setImportNotice("");
    setImportDuplicate(null);
    if (hasUnsavedChanges && !window.confirm("当前修改尚未保存，继续收取新网页吗？")) return;
    let normalized: string;
    try {
      normalized = normalizeCaptureUrl(value);
    } catch {
      setImportError("请输入完整的 http(s) 网页地址。");
      return;
    }
    await importDocument(normalized, false, beginNavigation());
  };

  const handleImport = async (event: FormEvent) => {
    event.preventDefault();
    await captureUrl(importUrl);
  };

  const openImportedDuplicate = async () => {
    if (!importDuplicate || closeAttemptRef.current || lifecycleAction || restoringRevision !== null) return;
    const prompt = importDuplicate;
    if (hasUnsavedChanges && prompt.document.id !== currentDoc?.id && !window.confirm("当前修改尚未保存，确定打开已有知识吗？")) return;
    const guard = beginNavigation();
    setImporting(true);
    setImportError("");
    try {
      if (!await revealDocument(prompt.document, guard)) return;
      setImportUrl("");
      setImportDuplicate(null);
      setImportNotice(prompt.document.deletedAt ? "已有知识在回收站中，可在右侧恢复。" : "已打开已有知识，没有创建重复条目。");
    } catch (error) {
      if (canApplyNavigation(guard)) setImportError((error as Error).message);
    } finally {
      setImporting(false);
    }
  };

  const keepImportedDuplicate = async () => {
    if (
      !importDuplicate || importDuplicate.kind !== "resolved" || closeAttemptRef.current ||
      lifecycleAction || restoringRevision !== null
    ) return;
    if (hasUnsavedChanges && !window.confirm("当前修改尚未保存，仍要保留为另一篇知识吗？")) return;
    await importDocument(importDuplicate.url, true, beginNavigation());
  };

  const clearBulkImport = () => {
    setBulkImportText("");
    setBulkImportFiles([]);
    setBulkImportPreview(null);
    setBulkImportResult(null);
    setBulkImportStrategy("skip");
    setBulkImportError("");
    setBulkImportNotice("");
  };

  const cancelBulkImportTask = () => {
    bulkImportAbortRef.current?.abort();
  };

  const cancelBulkPreview = async () => {
    if (!bulkImportPreview) return true;
    setBulkImportBusy(true);
    setBulkImportError("");
    try {
      await api.cancelImport(bulkImportPreview.id);
      return true;
    } catch (error) {
      if (bulkImportResult) {
        setImportNotice(`批量导入已完成（新增 ${bulkImportResult.counts.created}，更新 ${bulkImportResult.counts.updated}）；临时导入记录将在稍后清理。`);
        return true;
      }
      setBulkImportError((error as Error).message);
      return false;
    } finally {
      setBulkImportBusy(false);
    }
  };

  const closeBulkImport = async () => {
    if (bulkImportBusy || !await cancelBulkPreview()) return;
    setBulkImportOpen(false);
    clearBulkImport();
  };

  const restartBulkImport = async () => {
    if (!await cancelBulkPreview()) return;
    if (bulkImportKind !== "urls") setBulkImportFiles([]);
    setBulkImportPreview(null);
    setBulkImportResult(null);
    setBulkImportError("");
  };

  const selectBulkFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files || []);
    const files = acceptedImportFiles(bulkImportKind, selected);
    const error = selected.length && !files.length
      ? unsupportedImportFileMessage(bulkImportKind)
      : importFileLimitError(bulkImportKind, files);
    if (error) event.currentTarget.value = "";
    setBulkImportFiles(error ? [] : files);
    setBulkImportError(error);
    setBulkImportNotice("");
  };

  externalIntentHandlerRef.current = async (intents) => {
    const externalError = intents.find((intent): intent is Extract<ExternalIntent, { kind: "error" }> => intent.kind === "error");
    if (externalError) {
      setBulkImportError(externalError.message);
      setBulkImportOpen(true);
    }
    for (const intent of intents) {
      if (intent.kind !== "capture") continue;
      setImportUrl(intent.url);
      if (safetyOpen || bulkImportBusy) {
        setImportError("请先完成当前操作，网址已保留在收取栏。");
        continue;
      }
      await captureUrl(intent.url);
    }

    const fileIntents = intents.filter((intent): intent is Extract<ExternalIntent, { token: string }> => "token" in intent);
    if (!fileIntents.length) return;
    const pendingTokens = new Set(fileIntents.map((intent) => intent.token));
    try {
      const kind = fileIntents[0]!.kind;
      if (fileIntents.some((intent) => intent.kind !== kind)) throw new Error("一次只能打开一种导入文件。");
      if (safetyOpen) throw new Error("请先退出数据安全界面，再重新打开或拖入文件。");
      if (bulkImportBusy) throw new Error("当前导入完成后，请重新打开或拖入文件。");
      const files: File[] = [];
      for (const intent of fileIntents) {
        if (kind === "bundle") {
          const raw = await invoke<ArrayBuffer | Uint8Array<ArrayBuffer>>("read_external_binary", { token: intent.token });
          pendingTokens.delete(intent.token);
          const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
          files.push(new File([bytes], intent.name, { type: "application/zip" }));
        } else {
          const value = await invoke<ExternalTextFile>("read_external_text", { token: intent.token });
          pendingTokens.delete(intent.token);
          files.push(new File([value.content], value.name, { type: kind === "bookmarks" ? "text/html" : "text/markdown" }));
        }
      }
      const accepted = acceptedImportFiles(kind, files);
      const error = accepted.length !== files.length
        ? unsupportedImportFileMessage(kind)
        : importFileLimitError(kind, accepted);
      if (error) throw new Error(error);
      if (bulkImportPreview && !await cancelBulkPreview()) return;
      clearBulkImport();
      setBulkImportKind(kind);
      setBulkImportFiles(accepted);
      setBulkImportOpen(true);
      setBulkImportNotice(`已从桌面接收 ${accepted.length} 个文件，请检查后导入。`);
    } catch (error) {
      setBulkImportError((error as Error).message);
      setBulkImportOpen(true);
    } finally {
      if (pendingTokens.size) {
        try {
          await invoke("discard_external_tokens", { tokens: [...pendingTokens] });
        } catch (error) {
          setBulkImportError(`无法清理未读取的桌面文件：${(error as Error).message}`);
        }
      }
    }
  };

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let stopped = false;
    const drain = async () => {
      while (!stopped) {
        const intents = await invoke<ExternalIntent[]>("take_external_intents");
        if (!intents.length) break;
        await externalIntentHandlerRef.current(intents);
      }
    };
    let chain = Promise.resolve();
    const onReady = () => {
      chain = chain.then(drain).catch((error) => {
        if (!stopped) setImportError(`无法处理桌面导入：${(error as Error).message}`);
      });
    };
    window.addEventListener("zhiye:external-intents-ready", onReady);
    onReady();
    return () => {
      stopped = true;
      window.removeEventListener("zhiye:external-intents-ready", onReady);
    };
  }, []);

  const previewBulkImport = async () => {
    const controller = new AbortController();
    bulkImportAbortRef.current = controller;
    setBulkImportBusy(true);
    setBulkImportTask("validating");
    setBulkImportError("");
    setBulkImportNotice("正在校验导入内容…");
    setBulkImportResult(null);
    try {
      const fileError = importFileLimitError(bulkImportKind, bulkImportFiles);
      if (fileError) throw new Error(fileError);
      const markdownFiles: Array<{ path: string; content: string }> = [];
      if (bulkImportKind === "markdown") {
        for (const file of bulkImportFiles) {
          controller.signal.throwIfAborted();
          markdownFiles.push({ path: file.webkitRelativePath || file.name, content: await file.text() });
        }
      }
      if (bulkImportKind === "bundle") {
        setBulkImportPreview(await api.previewBundle(bulkImportFiles[0]!, controller.signal));
      } else {
        const payload = bulkImportKind === "urls"
          ? { kind: "urls" as const, content: bulkImportText }
          : bulkImportKind === "bookmarks"
            ? { kind: "bookmarks" as const, content: await bulkImportFiles[0]?.text() || "" }
            : { kind: "markdown" as const, files: markdownFiles };
        controller.signal.throwIfAborted();
        setBulkImportPreview(await api.previewImport(payload, controller.signal));
      }
      setBulkImportNotice("校验完成，请确认逐项结果与冲突策略。");
    } catch (error) {
      if ((error as Error).name === "AbortError") setBulkImportNotice("已取消校验。");
      else setBulkImportError((error as Error).message);
    } finally {
      if (bulkImportAbortRef.current === controller) bulkImportAbortRef.current = null;
      setBulkImportTask(null);
      setBulkImportBusy(false);
    }
  };

  const applyBulkImport = async () => {
    if (!bulkImportPreview) return;
    const controller = new AbortController();
    bulkImportAbortRef.current = controller;
    setBulkImportBusy(true);
    setBulkImportTask("importing");
    setBulkImportError("");
    setBulkImportNotice("正在导入知识…");
    try {
      const result = await api.applyImport(bulkImportPreview.id, bulkImportStrategy, controller.signal);
      setBulkImportResult(result);
      setListRefresh((value) => value + 1);
      void loadCaptureQueue();
      void loadCollections();
      refreshKnownTags();
      setImportNotice(`批量导入完成：新增 ${result.counts.created}，更新 ${result.counts.updated}，跳过 ${result.counts.skipped}。`);
      setBulkImportNotice(bulkImportPreview.kind === "bundle" ? "知识包已导入，资料库已刷新。" : "导入完成，资料库已刷新。");
      const currentId = selectedIdRef.current;
      if (currentId && result.items.some((item) => item.status === "updated" && item.documentId === currentId)) {
        const updated = await api.getDocument(currentId);
        if (selectedIdRef.current === currentId) {
          installCurrentDocument(updated);
          setDraft(draftOf(updated));
          setTagText(updated.tags.join(", "));
          updateListItem(updated);
        }
      }
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        setBulkImportNotice("已停止等待导入结果；服务端可能已完成，可再次确认导入以同步结果。");
        setListRefresh((value) => value + 1);
      } else setBulkImportError((error as Error).message);
    } finally {
      if (bulkImportAbortRef.current === controller) bulkImportAbortRef.current = null;
      setBulkImportTask(null);
      setBulkImportBusy(false);
    }
  };

  const toggleCaptureQueue = async () => {
    if (!captureQueue || closeAttemptRef.current) return;
    setQueueUpdating(true);
    setQueueError("");
    try {
      setCaptureQueue(await api.updateCaptureQueue(!captureQueue.paused));
    } catch (error) {
      setQueueError((error as Error).message);
    } finally {
      setQueueUpdating(false);
    }
  };

  const finishOrganizationUpdate = (updated: KnowledgeDocument, message: string) => {
    if (selectedIdRef.current !== updated.id) return;
    installCurrentDocument(updated);
    setDraft(draftOf(updated));
    setTagText(updated.tags.join(", "));
    updateListItem(updated);
    setListRefresh((value) => value + 1);
    updateOrganizationConflict(null);
    setOrganizationError("");
    setOrganizationNotice(message);
  };

  const commitOrganization = async (
    patch: Omit<DocumentPatch, "revision">,
    successMessage: string,
    baseDocument = currentDocRef.current,
    retryingConflict = false,
    rebase?: OrganizationConflict["rebase"],
  ) => {
    const body = draftRef.current;
    if (
      closeAttemptRef.current || organizationInFlight.current || saveInFlight.current || !baseDocument ||
      baseDocument.status !== "ready" || baseDocument.deletedAt || !body || !draftsEqual(body, draftOf(currentDocRef.current || baseDocument)) ||
      conflict || remoteDraftConflict || (!retryingConflict && organizationConflict)
    ) return false;
    setOrganizationSaving(true);
    setOrganizationError("");
    setOrganizationNotice("");
    return trackOrganizationTask((async () => {
      try {
        const updated = await sendOrganizationPatch(baseDocument, patch);
        finishOrganizationUpdate(updated, successMessage);
        if ("collectionIds" in patch) await loadCollections();
        return true;
      } catch (error) {
        if (
          error instanceof ApiRequestError && error.status === 409 && error.document &&
          selectedIdRef.current === baseDocument.id
        ) {
          updateOrganizationConflict({ server: error.document, patch, successMessage, rebase });
          setOrganizationError("这篇知识已在别处更新，请基于最新版本重试或放弃这次更改。");
        } else if (selectedIdRef.current === baseDocument.id) {
          setOrganizationError((error as Error).message);
        }
        return false;
      } finally {
        setOrganizationSaving(false);
      }
    })());
  };

  const saveSourceMetadata = async (event: FormEvent) => {
    event.preventDefault();
    if (!currentDoc || !sourceMetadata || organizationLocked) return;
    const patch = sourceMetadataPatch(sourceMetadata, currentDoc);
    if (!Object.keys(patch).length) return;
    await commitOrganization(patch, "来源信息已保存。");
  };

  const retryOrganizationUpdate = async () => {
    if (!organizationConflict) return;
    const pending = organizationConflict;
    const patch = pending.rebase ? pending.rebase(pending.server) : pending.patch;
    await commitOrganization(patch, pending.successMessage, pending.server, true, pending.rebase);
  };

  const discardOrganizationUpdate = () => {
    if (!organizationConflict) return;
    const server = organizationConflict.server;
    installCurrentDocument(server);
    setDraft(draftOf(server));
    setTagText(server.tags.join(", "));
    updateListItem(server);
    updateOrganizationConflict(null);
    setOrganizationError("");
    setOrganizationNotice("已放弃这次组织与来源信息更改。");
  };

  const toggleFavorite = async () => {
    if (!currentDoc || organizationLocked || metadataDirty) return;
    await commitOrganization(
      { favorite: !currentDoc.favorite },
      currentDoc.favorite ? "已取消收藏。" : "已加入收藏。",
    );
  };

  const toggleArchive = async () => {
    if (!currentDoc || organizationLocked || metadataDirty) return;
    await commitOrganization(
      { archived: !currentDoc.archivedAt },
      currentDoc.archivedAt ? "已取消归档。" : "已归档。",
    );
  };

  const toggleDocumentCollection = async (collectionId: string, checked: boolean) => {
    if (!currentDoc || organizationLocked || metadataDirty) return;
    const ids = currentDoc.collections.map((collection) => collection.id);
    const next = checked ? [...new Set([...ids, collectionId])] : ids.filter((id) => id !== collectionId);
    const rebase = (server: KnowledgeDocument) => {
      const serverIds = server.collections.map((collection) => collection.id);
      return {
        collectionIds: checked
          ? [...new Set([...serverIds, collectionId])]
          : serverIds.filter((id) => id !== collectionId),
      };
    };
    await commitOrganization(
      { collectionIds: next },
      checked ? "已加入集合。" : "已移出集合。",
      currentDoc,
      false,
      rebase,
    );
  };

  const adoptDerivedTags = async (tags: string[]) => {
    const document = currentDocRef.current;
    if (!document || organizationLocked || metadataDirty) throw new Error("请先保存或处理当前更改。");
    const next = [...new Set([...document.tags, ...tags])];
    if (next.length === document.tags.length) return;
    if (!await commitOrganization({ tags: next }, `已采纳 ${next.length - document.tags.length} 个 AI 建议标签。`)) {
      throw new Error("标签尚未采纳，请处理当前更改后重试。");
    }
  };

  const createCollection = async (event: FormEvent) => {
    event.preventDefault();
    const name = collectionName.trim();
    if (!name || organizationInFlight.current || closeAttemptRef.current) return;
    setCollectionAction("create");
    setOrganizationError("");
    setOrganizationNotice("");
    try {
      const created = await trackOrganizationTask(api.createCollection(name));
      invalidateCollectionsLoad();
      setCollections((previous) => [...previous, created].sort((a, b) => a.name.localeCompare(b.name, "zh-CN")));
      setCollectionName("");
      setOrganizationNotice(`已创建集合“${created.name}”。`);
    } catch (error) {
      setOrganizationError((error as Error).message);
    } finally {
      setCollectionAction(null);
    }
  };

  const renameCollection = async (event: FormEvent) => {
    event.preventDefault();
    if (!renamingCollection || organizationInFlight.current || closeAttemptRef.current) return;
    const name = renamingCollection.name.trim();
    if (!name) return;
    const id = renamingCollection.id;
    setCollectionAction(id);
    setOrganizationError("");
    setOrganizationNotice("");
    try {
      const updated = await trackOrganizationTask(api.updateCollection(id, name));
      invalidateCollectionsLoad();
      setCollections((previous) => previous.map((value) => value.id === id ? updated : value));
      setListRefresh((value) => value + 1);
      const document = currentDocRef.current;
      if (document?.collections.some((value) => value.id === id)) {
        const renamed = {
          ...document,
          collections: document.collections.map((value) => value.id === id ? { id, name: updated.name } : value),
        };
        currentDocRef.current = renamed;
        setCurrentDoc(renamed);
        updateListItem(renamed);
      }
      setRenamingCollection(null);
      setOrganizationNotice(`集合已更名为“${updated.name}”。`);
    } catch (error) {
      setOrganizationError((error as Error).message);
    } finally {
      setCollectionAction(null);
    }
  };

  const deleteCollection = async (collection: KnowledgeCollection) => {
    if (
      organizationInFlight.current || closeAttemptRef.current ||
      !window.confirm(`删除集合“${collection.name}”？它将从 ${collection.documentCount} 篇知识中移除，文档本身不会删除。`)
    ) return;
    setCollectionAction(collection.id);
    setOrganizationError("");
    setOrganizationNotice("");
    try {
      const document = currentDocRef.current;
      const { result, refreshed } = await trackOrganizationTask((async () => {
        const deleted = await api.deleteCollection(collection.id);
        invalidateCollectionsLoad();
        const nextDocument = document?.collections.some((value) => value.id === collection.id)
          ? await api.getDocument(document.id)
          : null;
        return { result: deleted, refreshed: nextDocument };
      })());
      setCollections((previous) => previous.filter((value) => value.id !== collection.id));
      setListRefresh((value) => value + 1);
      setRenamingCollection((value) => value?.id === collection.id ? null : value);
      if (refreshed && selectedIdRef.current === refreshed.id) {
        installCurrentDocument(refreshed);
        setDraft(draftOf(refreshed));
        setTagText(refreshed.tags.join(", "));
        updateListItem(refreshed);
      }
      setOrganizationNotice(`已删除集合“${collection.name}”，从 ${result.affectedDocuments} 篇知识中移除。`);
    } catch (error) {
      setOrganizationError((error as Error).message);
      void loadCollections();
    } finally {
      setCollectionAction(null);
    }
  };

  const refreshClassificationData = async () => {
    const [tags] = await Promise.all([api.listManagedTags(), loadCollections()]);
    setManagedTags(tags);
    refreshKnownTags();
    setListRefresh((value) => value + 1);
    const document = currentDocRef.current;
    if (document) {
      const refreshed = await api.getDocument(document.id);
      if (selectedIdRef.current === refreshed.id) {
        installCurrentDocument(refreshed);
        setDraft(draftOf(refreshed));
        setTagText(refreshed.tags.join(", "));
        updateListItem(refreshed);
      }
    }
  };

  const renameTag = async (tagValue: KnowledgeTag) => {
    const name = window.prompt(`将标签“${tagValue.name}”重命名为`, tagValue.name)?.trim();
    if (!name || name === tagValue.name || tagAction || organizationInFlight.current) return;
    setTagAction(tagValue.name);
    setOrganizationError("");
    try {
      const result = await trackOrganizationTask((async () => {
        const response = await api.renameTag(tagValue.name, name);
        await refreshClassificationData();
        return response;
      })());
      setOrganizationNotice(`已在 ${result.affectedDocuments} 篇知识中将标签更名为“${name}”。`);
    } catch (error) {
      setOrganizationError((error as Error).message);
    } finally {
      setTagAction(null);
    }
  };

  const mergeTag = async (tagValue: KnowledgeTag) => {
    const targetName = window.prompt(`将标签“${tagValue.name}”合并到哪个标签？`)?.trim();
    if (!targetName || targetName === tagValue.name || tagAction || organizationInFlight.current) return;
    if (!window.confirm(`将影响 ${tagValue.documentCount} 篇知识，源标签将被删除。继续？`)) return;
    setTagAction(tagValue.name);
    setOrganizationError("");
    try {
      const result = await trackOrganizationTask((async () => {
        const response = await api.mergeTag(tagValue.name, targetName);
        await refreshClassificationData();
        return response;
      })());
      setOrganizationNotice(`已合并 ${result.affectedDocuments} 篇知识的标签。`);
    } catch (error) {
      setOrganizationError((error as Error).message);
    } finally {
      setTagAction(null);
    }
  };

  const deleteTag = async (tagValue: KnowledgeTag) => {
    if (tagAction || organizationInFlight.current || !window.confirm(`从 ${tagValue.documentCount} 篇知识中移除标签“${tagValue.name}”？文档本身不会删除。`)) return;
    setTagAction(tagValue.name);
    setOrganizationError("");
    try {
      const result = await trackOrganizationTask((async () => {
        const response = await api.deleteTag(tagValue.name);
        await refreshClassificationData();
        return response;
      })());
      setOrganizationNotice(`已从 ${result.affectedDocuments} 篇知识中移除标签。`);
    } catch (error) {
      setOrganizationError((error as Error).message);
    } finally {
      setTagAction(null);
    }
  };

  const mergeCollection = async (collection: KnowledgeCollection) => {
    const targetName = window.prompt(`将集合“${collection.name}”合并到哪个集合？`)?.trim();
    const target = collections.find((value) => value.name.toLocaleLowerCase() === targetName?.toLocaleLowerCase());
    if (!targetName || !target || target.id === collection.id) {
      if (targetName) setOrganizationError("请输入另一个已有集合的完整名称。");
      return;
    }
    if (!window.confirm(`将影响 ${collection.documentCount} 篇知识，源集合将被删除。继续？`)) return;
    setCollectionAction(collection.id);
    setOrganizationError("");
    try {
      const result = await trackOrganizationTask((async () => {
        const response = await api.mergeCollection(collection.id, target.id);
        await refreshClassificationData();
        return response;
      })());
      setOrganizationNotice(`已合并 ${result.affectedDocuments} 篇知识的集合。`);
    } catch (error) {
      setOrganizationError((error as Error).message);
    } finally {
      setCollectionAction(null);
    }
  };

  const openResolvedDuplicate = async () => {
    if (!resolvedDuplicate || closeAttemptRef.current || lifecycleAction || restoringRevision !== null) return;
    if (hasUnsavedChanges && !window.confirm("当前修改尚未保存，确定打开已有知识吗？")) return;
    const duplicate = resolvedDuplicate;
    const guard = beginNavigation();
    setResolvedDuplicate(null);
    setDuplicateNotice("");
    try {
      if (!await revealDocument(duplicate, guard)) {
        if (navigationGenerationRef.current === guard.generation && selectedIdRef.current === guard.selectedId) {
          setResolvedDuplicate(duplicate);
        }
        return;
      }
      if (currentDoc) keptDuplicateIdsRef.current.add(currentDoc.id);
      keptDuplicateIdsRef.current.add(duplicate.id);
      setImportNotice(duplicate.deletedAt ? "重复知识在回收站中，可在右侧恢复。" : "已打开已有知识；当前条目仍完整保留。");
    } catch (error) {
      if (canApplyNavigation(guard)) {
        setResolvedDuplicate(duplicate);
        setDetailError((error as Error).message);
      }
    }
  };

  const keepResolvedDuplicate = () => {
    if (currentDoc) keptDuplicateIdsRef.current.add(currentDoc.id);
    setResolvedDuplicate(null);
    setDuplicateNotice("已保留两篇知识，当前条目没有被删除。");
  };

  const selectDocument = (id: string) => {
    if (closeAttemptRef.current || organizationInFlight.current || id === selectedId || lifecycleAction || restoringRevision !== null) return;
    if (hasUnsavedChanges && !window.confirm("当前修改尚未保存，确定离开吗？")) return;
    invalidateNavigation();
    setSelectedId(id);
  };

  const closeDocument = () => {
    if (closeAttemptRef.current || organizationInFlight.current || lifecycleAction || restoringRevision !== null) return;
    if (hasUnsavedChanges && !window.confirm("当前修改尚未保存，确定离开吗？")) return;
    invalidateNavigation();
    setSelectedId(null);
  };

  const applyLibraryView = (view: LibraryView) => {
    if (closeAttemptRef.current || organizationInFlight.current || lifecycleAction || restoringRevision !== null) return false;
    if (hasUnsavedChanges && !window.confirm("当前修改尚未保存，确定离开吗？")) return false;
    invalidateNavigation();
    setLibraryView(view);
    setInTrash(view === "trash");
    setPage(1);
    setItems([]);
    setSelectedId(null);
    setSelectedIds(new Set());
    setQuery("");
    setSearchScope("all");
    setTag("");
    setCollectionFilter("");
    setCaptureModeFilter("");
    setDateTo("");
    setFavoriteFilter(view === "favorites" ? true : undefined);
    setArchivedFilter(view === "archived" ? true : view === "unorganized" ? false : undefined);
    setUnorganizedFilter(view === "unorganized");
    setStatus(view === "failed" ? "failed" : "");
    setDateFrom(view === "recent" ? new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10) : "");
    setImportNotice("");
    return true;
  };

  const applySavedFilter = (saved: SavedFilter) => {
    if (!applyLibraryView("all")) return;
    setQuery(saved.query);
    setSearchScope(saved.scope);
    setTag(saved.tag);
    setCollectionFilter(saved.collectionId);
    setStatus(saved.status);
    setFavoriteFilter(saved.favorite);
    setArchivedFilter(saved.archived);
    setUnorganizedFilter(Boolean(saved.unorganized));
    setCaptureModeFilter(saved.captureMode);
    setDateFrom(saved.from);
    setDateTo(saved.to);
    setSortOrder(saved.sort);
  };

  const runBatchAction = async () => {
    if (
      !batchAction || !selectedIds.size || batchBusy || listLoading || hasUnsavedChanges ||
      organizationInFlight.current || itemsContextRef.current !== listContextKey ||
      selectionContextRef.current !== listContextKey
    ) return;
    const requestContext = listContextKey;
    let value: string | undefined;
    if (batchAction === "add-tag" || batchAction === "remove-tag") {
      value = window.prompt(batchAction === "add-tag" ? "输入要添加的标签" : "输入要移除的标签")?.trim();
      if (!value) return;
    }
    if (batchAction === "add-collection" || batchAction === "remove-collection") {
      value = batchCollectionId;
      if (!value) return;
    }
    if (batchAction === "trash" && !window.confirm(`将当前页选中的 ${selectedIds.size} 篇知识移入回收站？`)) return;
    setBatchBusy(true);
    setBatchError("");
    setBatchNotice("");
    try {
      await trackOrganizationTask((async () => {
        const result = await api.batchDocuments({
          documents: items.filter((item) => selectedIds.has(item.id)).map((item) => ({ id: item.id, revision: item.revision })),
          action: batchAction,
          value,
        });
        if (listContextRef.current === requestContext) {
          setBatchNotice(`已处理当前页选中的 ${result.affectedDocuments} 篇知识。`);
          if (selectedIdRef.current && (batchAction === "trash" || batchAction === "restore")) {
            invalidateNavigation();
            setSelectedId(null);
          } else if (selectedIdRef.current) {
            try {
              const document = await api.getDocument(selectedIdRef.current);
              installCurrentDocument(document);
              setDraft(draftOf(document));
              setTagText(document.tags.join(", "));
              updateListItem(document);
            } catch {
              setSelectedId(null);
            }
          }
        }
        selectionContextRef.current = null;
        setSelectedIds(new Set());
        setBatchAction("");
        setListRefresh((value) => value + 1);
        await loadCollections();
        refreshKnownTags();
      })());
    } catch (error) {
      setBatchError((error as Error).message);
    } finally {
      setBatchBusy(false);
    }
  };

  const exportPortable = async (scope: "selected" | "all") => {
    if (portableExporting) {
      portableExportAbortRef.current?.abort();
      return;
    }
    if (closeAttemptRef.current || listLoading) return;
    const documentIds = scope === "selected"
      ? items.filter((item) => selectedIds.has(item.id)).map((item) => item.id)
      : [];
    if (
      inTrash || (scope === "selected" && (
        !documentIds.length || itemsContextRef.current !== listContextKey || selectionContextRef.current !== listContextKey
      ))
    ) return;
    const controller = new AbortController();
    portableExportAbortRef.current = controller;
    setPortableExporting(scope);
    setPortableNotice(scope === "all" ? "正在导出全部知识包…" : `正在导出所选 ${documentIds.length} 篇知识…`);
    setPortableError("");
    try {
      const { blob, fileName } = await api.exportPortable(scope, documentIds, controller.signal);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setPortableNotice(`知识包已生成：${fileName}`);
    } catch (error) {
      if ((error as Error).name === "AbortError") setPortableNotice("已取消知识包导出。");
      else setPortableError((error as Error).message);
    } finally {
      if (portableExportAbortRef.current === controller) portableExportAbortRef.current = null;
      setPortableExporting(null);
    }
  };

  const alignLibraryWithDocument = (document: KnowledgeDocument) => {
    const targetIsTrash = Boolean(document.deletedAt);
    if (targetIsTrash === inTrash) {
      updateListItem(document);
      return;
    }
    setInTrash(targetIsTrash);
    setPage(1);
    setItems([]);
    setTag("");
  };

  const handleListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key.toLowerCase() === "x") {
      const checkbox = (document.activeElement as HTMLElement | null)?.closest(".document-row-wrap")?.querySelector<HTMLInputElement>(".row-select input");
      if (checkbox && !checkbox.disabled) {
        event.preventDefault();
        checkbox.click();
      }
      return;
    }
    const key = event.key.toLowerCase();
    if (key !== "arrowdown" && key !== "arrowup" && key !== "j" && key !== "k") return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".document-row")];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    buttons[Math.max(0, Math.min(buttons.length - 1, index + (key === "arrowdown" || key === "j" ? 1 : -1)))]?.focus();
  };

  useEffect(() => {
    const handleShortcuts = (event: globalThis.KeyboardEvent) => {
      if (bulkImportOpen) return;
      if (shortcutHelp) {
        if (event.key === "Escape") setShortcutHelp(false);
        return;
      }
      const target = event.target as HTMLElement | null;
      const editing = Boolean(target?.closest("input, textarea, select, [contenteditable='true']"));
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      if (!editing && event.key === "/") {
        event.preventDefault();
        searchInputRef.current?.focus();
      } else if (!editing && event.key === "?") {
        event.preventDefault();
        setShortcutHelp(true);
      } else if (!editing && (event.key.toLowerCase() === "j" || event.key.toLowerCase() === "k") && !libraryListRef.current?.contains(document.activeElement)) {
        event.preventDefault();
        const rows = [...(libraryListRef.current?.querySelectorAll<HTMLButtonElement>(".document-row") || [])];
        (rows.find((row) => row.getAttribute("aria-current") === "true") || rows[0])?.focus();
      } else if (event.key === "Escape") {
        if (shortcutHelp) setShortcutHelp(false);
        else if (collectionsOpen || qualityOpen || captureHistoryOpen || historyOpen || derivedOpen) {
          setCollectionsOpen(false);
          setQualityOpen(false);
          setCaptureHistoryOpen(false);
          setHistoryOpen(false);
          setDerivedOpen(false);
        } else if (!editing) closeDocument();
      }
    };
    window.addEventListener("keydown", handleShortcuts);
    return () => window.removeEventListener("keydown", handleShortcuts);
  }, [bulkImportOpen, captureHistoryOpen, closeDocument, collectionsOpen, derivedOpen, historyOpen, qualityOpen, shortcutHelp]);

  const retryCapture = async () => {
    if (!currentDoc) return;
    setRetrying(true);
    setDetailError("");
    try {
      const updated = await api.retryDocument(currentDoc.id);
      installCurrentDocument(updated);
      setDraft(draftOf(updated));
      setTagText(updated.tags.join(", "));
      updateListItem(updated);
      void loadCaptureQueue();
    } catch (error) {
      setDetailError((error as Error).message);
    } finally {
      setRetrying(false);
    }
  };

  const cancelCapture = async () => {
    if (!currentDoc || currentDoc.status !== "queued" || closeAttemptRef.current) return;
    const documentId = currentDoc.id;
    setCancelling(true);
    setDetailError("");
    try {
      const updated = await api.cancelDocument(documentId);
      if (selectedIdRef.current !== documentId) return;
      installCurrentDocument(updated);
      setDraft(draftOf(updated));
      setTagText(updated.tags.join(", "));
      updateListItem(updated);
      void loadCaptureQueue();
    } catch (error) {
      if (selectedIdRef.current === documentId) setDetailError((error as Error).message);
    } finally {
      setCancelling(false);
    }
  };

  const moveToTrash = async () => {
    if (closeAttemptRef.current || organizationInFlight.current || remoteDraftConflict || organizationConflict || !currentDoc || hasUnsavedChanges || !window.confirm(`把“${currentDoc.title || "未命名网页"}”移入回收站？之后可以恢复。`)) return;
    setLifecycleAction("delete");
    setDetailError("");
    try {
      const deleted = await api.deleteDocument(currentDoc.id, currentDoc.revision);
      installCurrentDocument(deleted);
      setDraft(draftOf(deleted));
      setTagText(deleted.tags.join(", "));
      setInTrash(true);
      setPage(1);
      setItems([]);
      setHistoryOpen(false);
      focusReader();
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 409 && error.document) {
        installCurrentDocument(error.document);
        setDraft(draftOf(error.document));
        setTagText(error.document.tags.join(", "));
        alignLibraryWithDocument(error.document);
      }
      setDetailError((error as Error).message);
    } finally {
      setLifecycleAction(null);
    }
  };

  const restoreFromTrash = async () => {
    if (closeAttemptRef.current || importing || !currentDoc) return;
    const document = currentDoc;
    const guard = beginNavigation();
    const recovered = dirty && draft ? { ...draft, tags: [...draft.tags] } : null;
    setLifecycleAction("restore");
    setDetailError("");
    try {
      const restored = await api.restoreDocument(document.id, document.revision);
      if (!canApplyNavigation(guard)) return;
      installCurrentDocument(restored);
      if (recovered) {
        setDraft(recovered);
        setTagText(recovered.tags.join(", "));
        setConflict(restored);
        setSaveState("conflict");
      } else {
        setDraft(draftOf(restored));
        setTagText(restored.tags.join(", "));
      }
      setInTrash(false);
      setPage(1);
      setItems([]);
      focusReader();
    } catch (error) {
      if (!canApplyNavigation(guard)) return;
      if (error instanceof ApiRequestError && error.status === 409 && error.document) {
        installCurrentDocument(error.document);
        alignLibraryWithDocument(error.document);
        if (recovered) {
          setDraft(recovered);
          setTagText(recovered.tags.join(", "));
          setConflict(error.document);
          setSaveState("conflict");
        } else {
          setDraft(draftOf(error.document));
          setTagText(error.document.tags.join(", "));
        }
      }
      setDetailError((error as Error).message);
    } finally {
      setLifecycleAction(null);
    }
  };

  const permanentlyDelete = async () => {
    if (closeAttemptRef.current || organizationInFlight.current || !currentDoc || hasUnsavedChanges || conflict || organizationConflict || remoteDraftConflict || !window.confirm(`永久删除“${currentDoc.title || "未命名网页"}”？抓取快照和历史版本也会被删除，此操作无法撤销。`)) return;
    setLifecycleAction("permanent");
    setDetailError("");
    try {
      const stored = persistedDraftRef.current;
      await api.permanentlyDeleteDocument(
        currentDoc.id,
        currentDoc.revision,
        stored?.documentId === currentDoc.id ? stored.draftRevision : null,
      );
      setItems((previous) => previous.filter((item) => item.id !== currentDoc.id));
      setTotal((value) => Math.max(0, value - 1));
      setPage(1);
      invalidateNavigation();
      setSelectedId(null);
      focusReader();
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === "DRAFT_EXISTS") {
        try {
          await reloadDraftConflict(currentDoc.id);
        } catch (reloadError) {
          setDetailError((reloadError as Error).message);
          return;
        }
        setDetailError((error as Error).message);
        return;
      }
      if (error instanceof ApiRequestError && error.status === 409 && error.document) {
        installCurrentDocument(error.document);
        alignLibraryWithDocument(error.document);
        if (error.code !== "DRAFT_EXISTS") {
          setDraft(draftOf(error.document));
          setTagText(error.document.tags.join(", "));
        }
      }
      setDetailError((error as Error).message);
    } finally {
      setLifecycleAction(null);
    }
  };

  const toggleHistory = async () => {
    if (closeAttemptRef.current || organizationInFlight.current || hasUnsavedChanges) return;
    if (!currentDoc || historyOpen) {
      setHistoryOpen(false);
      return;
    }
    const documentId = currentDoc.id;
    setCaptureHistoryOpen(false);
    setQualityOpen(false);
    setCollectionsOpen(false);
    setDerivedOpen(false);
    setHistoryOpen(true);
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const result = await api.listDocumentRevisions(documentId);
      if (selectedIdRef.current === documentId) setRevisions(result);
    } catch (error) {
      if (selectedIdRef.current === documentId) setHistoryError((error as Error).message);
    } finally {
      if (selectedIdRef.current === documentId) setHistoryLoading(false);
    }
  };

  const toggleCaptureHistory = () => {
    if (closeAttemptRef.current || !currentDoc) return;
    setHistoryOpen(false);
    setQualityOpen(false);
    setCollectionsOpen(false);
    setDerivedOpen(false);
    setCaptureHistoryOpen((value) => !value);
  };

  const toggleQuality = () => {
    if (closeAttemptRef.current || !currentDoc) return;
    setHistoryOpen(false);
    setCaptureHistoryOpen(false);
    setCollectionsOpen(false);
    setDerivedOpen(false);
    setQualityOpen((value) => !value);
  };

  const toggleCollectionManager = () => {
    if (closeAttemptRef.current || !currentDoc) return;
    setHistoryOpen(false);
    setCaptureHistoryOpen(false);
    setQualityOpen(false);
    setDerivedOpen(false);
    setRenamingCollection(null);
    if (!collectionsOpen) {
      void api.listManagedTags().then(setManagedTags).catch((error) => setOrganizationError((error as Error).message));
    }
    setCollectionsOpen((value) => !value);
  };

  const toggleDerived = () => {
    if (closeAttemptRef.current || !currentDoc) return;
    setHistoryOpen(false);
    setCaptureHistoryOpen(false);
    setQualityOpen(false);
    setCollectionsOpen(false);
    setDerivedOpen((value) => !value);
  };

  const applyReextraction = async (
    preview: ReextractionPreview,
    applyTitle: boolean,
    applyMarkdown: boolean,
  ) => {
    if (closeAttemptRef.current || !currentDoc || !draft || (!applyTitle && !applyMarkdown)) return;
    setCaptureApplying(true);
    try {
      await draftSaveChain.current;
      const current = currentDocRef.current;
      const value = draftRef.current;
      if (!current || !value || current.id !== currentDoc.id || !draftsEqual(value, draftOf(current))) {
        throw new Error("请先保存或放弃当前编辑，再采纳快照候选。");
      }
      if (current.revision !== preview.baseRevision) {
        throw new Error("文档已变化，请重新从快照生成对比。");
      }
      const stored = persistedDraftRef.current;
      if (stored?.documentId === current.id) {
        await tombstoneDraft(current.id, stored.draftRevision);
        await draftSaveChain.current;
      }
      const updated = await api.updateDocument(current.id, {
        revision: preview.baseRevision,
        ...(applyTitle ? { title: preview.after.title } : {}),
        ...(applyMarkdown ? { markdown: preview.after.markdown } : {}),
      });
      if (selectedIdRef.current === updated.id) {
        installCurrentDocument(updated);
        setDraft(draftOf(updated));
        setTagText(updated.tags.join(", "));
        setSaveState("saved");
        updateListItem(updated);
        refreshKnownTags();
      }
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 409 && error.document) {
        if (selectedIdRef.current === error.document.id) {
          installCurrentDocument(error.document);
          setDraft(draftOf(error.document));
          setTagText(error.document.tags.join(", "));
          alignLibraryWithDocument(error.document);
        }
        throw new Error("文档已在别处变化，请重新从快照生成对比。");
      }
      throw error;
    } finally {
      setCaptureApplying(false);
    }
  };

  const restoreRevision = async (revision: DocumentRevision) => {
    if (closeAttemptRef.current || organizationInFlight.current || importing || !currentDoc || hasUnsavedChanges) return;
    const document = currentDoc;
    const guard = beginNavigation();
    setRestoringRevision(revision.revision);
    setHistoryError("");
    try {
      const restored = await api.restoreDocumentRevision(document.id, revision.revision, document.revision);
      if (!canApplyNavigation(guard)) return;
      installCurrentDocument(restored);
      setDraft(draftOf(restored));
      setTagText(restored.tags.join(", "));
      updateListItem(restored);
      refreshKnownTags();
      setHistoryOpen(false);
      setSaveState("saved");
      focusReader();
    } catch (error) {
      if (!canApplyNavigation(guard)) return;
      if (error instanceof ApiRequestError && error.status === 409 && error.document) {
        setDraft({ title: revision.title, markdown: revision.markdown, tags: [...revision.tags] });
        setTagText(revision.tags.join(", "));
        setConflict(error.document);
        setSaveState("conflict");
        setHistoryOpen(false);
        focusReader();
      } else {
        setHistoryError((error as Error).message);
      }
    } finally {
      setRestoringRevision(null);
    }
  };

  const useRemoteDraft = () => {
    if (closeAttemptRef.current || !currentDoc || !remoteDraftConflict) return;
    const remote = remoteDraftConflict.remote;
    let hasDocumentConflict = Boolean(conflict);
    if (remote) {
      const value = { title: remote.title, markdown: remote.markdown, tags: [...remote.tags] };
      persistedDraftRef.current = remote;
      setDraft(value);
      setTagText(value.tags.join(", "));
      setDraftNotice("已切换到另一窗口的草稿。");
      if (remote.baseRevision !== currentDoc.revision || currentDoc.deletedAt) {
        setConflict(currentDoc);
        hasDocumentConflict = true;
      }
    } else {
      persistedDraftRef.current = null;
      setDraft(draftOf(currentDoc));
      setTagText(currentDoc.tags.join(", "));
      setDraftNotice("另一窗口已放弃草稿，已恢复正式版本。");
    }
    setRemoteDraftConflict(null);
    setDraftError("");
    setSaveState(hasDocumentConflict ? "conflict" : "idle");
  };

  const keepLocalDraft = async () => {
    if (closeAttemptRef.current || !currentDoc || !draft || !remoteDraftConflict) return;
    const local = { ...draft, tags: [...draft.tags] };
    const expected = remoteDraftConflict.remote?.draftRevision ?? null;
    setSaveState("saving");
    setSaveError("");
    try {
      await persistDraft(currentDoc, local, expected);
      setRemoteDraftConflict(null);
      setDraftNotice("已保留本窗口的草稿。");
      setSaveState(conflict ? "conflict" : "idle");
    } catch (error) {
      if (!(error instanceof ApiRequestError) || error.code !== "DRAFT_CONFLICT") {
        setDraftError((error as Error).message);
        setSaveState("error");
      }
    }
  };

  const acceptServerVersion = async () => {
    if (closeAttemptRef.current || remoteDraftConflict || !conflict) return;
    const server = conflict;
    setSaveState("saving");
    setSaveError("");
    try {
      await tombstoneDraft(server.id);
      const latest = await api.getDocument(server.id);
      persistedDraftRef.current = null;
      installCurrentDocument(latest);
      setDraft(draftOf(latest));
      setTagText(latest.tags.join(", "));
      updateListItem(latest);
      if (latest.deletedAt) {
        setInTrash(true);
        setTag("");
        setPage(1);
        setItems([]);
      }
      setConflict(null);
      setRemoteDraftConflict(null);
      setDraftNotice("");
      setSaveState("idle");
      focusReader();
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === "DRAFT_CONFLICT") {
        try {
          await reloadDraftConflict(server.id);
        } catch (reloadError) {
          setSaveError((reloadError as Error).message);
          setDraftError((reloadError as Error).message);
          setSaveState("conflict");
          return;
        }
        setSaveError((error as Error).message);
        setDraftError((error as Error).message);
        return;
      }
      setSaveError((error as Error).message);
      setDraftError((error as Error).message);
      setSaveState("conflict");
    }
  };

  const keepLocalVersion = async () => {
    if (closeAttemptRef.current || remoteDraftConflict || !conflict || !draft) return;
    const local = { ...draft, tags: [...draft.tags] };
    const wasDeleted = Boolean(conflict.deletedAt);
    setSaveState("saving");
    setSaveError("");
    try {
      const base = wasDeleted ? await api.restoreDocument(conflict.id, conflict.revision) : conflict;
      await persistDraft(base, local);
      const updated = await api.updateDocument(base.id, { ...local, revision: base.revision });
      persistedDraftRef.current = null;
      installCurrentDocument(updated);
      setDraft(draftOf(updated));
      setTagText(updated.tags.join(", "));
      setConflict(null);
      setDraftNotice("");
      setSaveState("saved");
      setPage(1);
      if (wasDeleted) {
        setInTrash(false);
        setTag("");
      }
      updateListItem(updated);
      setListRefresh((value) => value + 1);
      void api.listTags().then(setKnownTags).catch(() => undefined);
      focusReader();
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === "DRAFT_CONFLICT") {
        // persistDraft keeps the local value and exposes the remote draft resolution banner.
      } else if (error instanceof ApiRequestError && error.status === 409 && error.document) {
        setConflict(error.document);
      } else {
        setDetailError((error as Error).message);
      }
      setSaveState("conflict");
    }
  };

  const filteredDescription = useMemo(() => {
    const parts = [
      query && `“${query}”`,
      tag && `#${tag}`,
      collectionFilter && collections.find((value) => value.id === collectionFilter)?.name,
      status && STATUS_LABEL[status],
      favoriteFilter === true && "已收藏",
      archivedFilter === true && "已归档",
      unorganizedFilter && "未整理",
    ].filter(Boolean);
    return parts.length ? parts.join(" · ") : inTrash ? "已移除的网页" : "全部网页";
  }, [archivedFilter, collectionFilter, collections, favoriteFilter, inTrash, query, status, tag, unorganizedFilter]);
  const queueLabel = !captureQueue
    ? "正在读取队列"
    : captureQueue.paused
      ? `队列已暂停${captureQueue.active ? ` · ${captureQueue.active} 篇仍在完成` : ""} · ${captureQueue.queued} 篇等待`
      : captureQueue.active
        ? `正在采集 ${captureQueue.active} 篇 · ${captureQueue.queued} 篇等待`
        : captureQueue.queued
          ? `${captureQueue.queued} 篇等待采集`
          : "采集队列空闲";
  const captureBlockedReason = !currentDoc || currentDoc.status !== "ready"
    ? "只能从已就绪的文档采纳候选。"
    : currentDoc.deletedAt
      ? "先从回收站恢复文档，再采纳候选。"
      : hasUnsavedChanges || saveState === "saving" || organizationSaving
        ? "请先保存或放弃当前编辑。"
        : conflict || remoteDraftConflict || organizationConflict
          ? "请先处理当前的版本或草稿冲突。"
          : null;
  const derivedBlockedReason = !currentDoc || currentDoc.status !== "ready"
    ? "只能为已就绪的文档生成派生知识。"
    : currentDoc.deletedAt
      ? "请先从回收站恢复文档。"
      : hasUnsavedChanges || saveState === "saving" || organizationSaving
        ? "请先保存当前编辑，发送范围才能准确对应正式版本。"
        : conflict || remoteDraftConflict || organizationConflict
          ? "请先处理当前版本或草稿冲突。"
          : null;
  const qualityIssues: Array<{ title: string; detail: string }> = [];
  if (currentDoc?.status === "ready") {
    const bodyLength = currentDoc.markdown.replace(/\s/gu, "").length;
    if (bodyLength < 200) {
      qualityIssues.push({
        title: "正文可能不完整",
        detail: `当前正文约 ${bodyLength} 个非空白字符。可在采集历史中比较 HTML 快照的重新提取结果。`,
      });
    }
    if (!currentDoc.title.trim() || currentDoc.title.trim().toLowerCase() === sourceName(currentDoc.sourceUrl).toLowerCase()) {
      qualityIssues.push({
        title: "未可靠识别标题",
        detail: "当前标题仍像来源域名。可直接在上方标题框中补充，保存后不会被后续采集静默覆盖。",
      });
    }
    const failedAssets = assets.filter((asset) => asset.status === "failed").length;
    if (failedAssets) {
      qualityIssues.push({
        title: `${failedAssets} 张图片未能离线保存`,
        detail: "预览不会回连原站；原始图片 URL 仍保留在 Markdown 中，可检查地址后手动调整。",
      });
    }
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#library-panel">跳到资料库</a>
      <header className="masthead">
        <div className="brand" aria-label="织页本地知识库">
          <span className="brand-seal">织</span>
          <span><strong>织页</strong><small>ZHIYE · LOCAL KNOWLEDGE</small></span>
        </div>
        <p className="masthead-note">把散落的网页，<br />织成可编辑的知识。</p>
        <div className="masthead-actions"><button type="button" className="shortcut-help-button" onClick={() => setShortcutHelp(true)} aria-label="查看快捷键">?</button><button type="button" className="local-mark ai-settings-link" aria-pressed={aiSettingsOpen} onClick={() => { setSafetyOpen(false); setHistoryOpen(false); setCaptureHistoryOpen(false); setQualityOpen(false); setCollectionsOpen(false); setDerivedOpen(false); setAiSettingsOpen(true); }} disabled={closing}>AI 设置</button><button type="button" className="local-mark" aria-pressed={safetyOpen} onClick={() => { setAiSettingsOpen(false); setSafetyOpen(true); }} disabled={closing}>
          <i />{safetyRecovery ? "恢复模式" : "数据安全"}
        </button></div>
      </header>

      {shortcutHelp && <dialog ref={shortcutDialogRef} className="shortcut-backdrop" aria-labelledby="shortcut-title" onClose={() => setShortcutHelp(false)} onMouseDown={(event) => { if (event.target === event.currentTarget) setShortcutHelp(false); }}><section className="shortcut-card"><header><div><span className="eyebrow">KEYBOARD MAP</span><h2 id="shortcut-title">快捷键</h2></div><button type="button" autoFocus onClick={() => setShortcutHelp(false)} aria-label="关闭快捷键">×</button></header><dl><div><dt><kbd>⌘</kbd><kbd>K</kbd></dt><dd>聚焦搜索</dd></div><div><dt><kbd>/</kbd></dt><dd>聚焦搜索</dd></div><div><dt><kbd>J</kbd> / <kbd>K</kbd></dt><dd>在列表中移动</dd></div><div><dt><kbd>X</kbd></dt><dd>选中或取消当前行</dd></div><div><dt><kbd>↵</kbd></dt><dd>打开当前行</dd></div><div><dt><kbd>⌘</kbd><kbd>S</kbd></dt><dd>立即保存</dd></div><div><dt><kbd>Esc</kbd></dt><dd>关闭面板或返回列表</dd></div><div><dt><kbd>?</kbd></dt><dd>显示本帮助</dd></div></dl></section></dialog>}

      {bulkImportOpen && (
        <dialog
          ref={bulkImportDialogRef}
          className="shortcut-backdrop bulk-import-backdrop"
          aria-labelledby="bulk-import-title"
          onCancel={(event) => { event.preventDefault(); if (bulkImportTask) cancelBulkImportTask(); else void closeBulkImport(); }}
          onMouseDown={(event) => { if (event.target === event.currentTarget) void closeBulkImport(); }}
        >
          <section className="bulk-import-card">
            <header>
              <div><span className="eyebrow">BATCH INTAKE</span><h2 id="bulk-import-title">批量导入</h2><p>{bulkImportKind === "bundle" ? "恢复便携知识包；完整留档仍在“数据安全”中管理。" : "先检查，再一次写入资料库。"}</p></div>
              {bulkImportTask
                ? <button className="bulk-cancel-task" type="button" autoFocus onClick={cancelBulkImportTask}>{bulkImportTask === "validating" ? "取消校验" : "取消导入"}</button>
                : <button type="button" autoFocus onClick={() => void closeBulkImport()} disabled={bulkImportBusy} aria-label="关闭批量导入">×</button>}
            </header>

            {!bulkImportPreview ? <>
              <fieldset className="bulk-kind" disabled={bulkImportBusy}>
                <legend className="sr-only">导入格式</legend>
                {([['urls', '网址列表'], ['bookmarks', '浏览器书签'], ['markdown', 'Markdown'], ['bundle', '织页知识包']] as Array<[ImportKind, string]>).map(([kind, label]) => (
                  <button key={kind} type="button" aria-pressed={bulkImportKind === kind} onClick={() => { setBulkImportKind(kind); setBulkImportFiles([]); setBulkImportText(""); setBulkImportStrategy("skip"); setBulkImportError(""); setBulkImportNotice(""); }}>{label}</button>
                ))}
              </fieldset>

              {bulkImportKind === "urls" ? (
                <label className="bulk-text"><span>每行一个公开网页地址</span><textarea value={bulkImportText} onChange={(event) => { setBulkImportText(event.target.value); setBulkImportError(""); }} rows={10} placeholder={'https://example.com/article-one\nhttps://example.com/article-two'} disabled={bulkImportBusy} /></label>
              ) : bulkImportKind === "bookmarks" ? (
                <label className="bulk-file"><span>选择浏览器导出的 bookmarks.html</span><input key={bulkImportKind} type="file" accept=".html,text/html" onChange={selectBulkFiles} disabled={bulkImportBusy} /><small>{bulkImportFiles[0]?.name || "尚未选择文件"}</small></label>
              ) : bulkImportKind === "markdown" ? (
                <div className="bulk-markdown-files">
                  <label className="bulk-file"><span>选择多个 .md 文件</span><input key={`${bulkImportKind}-files`} type="file" accept=".md,.markdown,text/markdown,text/plain" multiple onChange={selectBulkFiles} disabled={bulkImportBusy} /></label>
                  <span>或</span>
                  <label className="bulk-file"><span>选择整个目录</span><input key={`${bulkImportKind}-directory`} type="file" multiple {...{ webkitdirectory: "", directory: "" }} onChange={selectBulkFiles} disabled={bulkImportBusy} /></label>
                  <small>{bulkImportFiles.length ? `已选择 ${bulkImportFiles.length} 个文件` : "尚未选择文件"}</small>
                </div>
              ) : (
                <label className="bulk-file bulk-bundle-file"><span>选择织页导出的 .zip 知识包</span><input key={bulkImportKind} type="file" accept=".zip,application/zip" onChange={selectBulkFiles} disabled={bulkImportBusy} /><small>{bulkImportFiles[0] ? `${bulkImportFiles[0].name} · ${(bulkImportFiles[0].size / 1024 / 1024).toFixed(1)} MiB` : "上限 100 MiB；文件保持二进制传输"}</small></label>
              )}

              <div className="bulk-dialog-actions"><button className="primary-button" type="button" onClick={() => void previewBulkImport()} disabled={bulkImportBusy || !bulkImportReady}>{bulkImportBusy ? <><Spinner />检查中</> : "检查导入内容"}</button></div>
            </> : <>
              <div className={`bulk-counts ${bulkImportPreview.kind === "bundle" ? "has-assets" : ""}`} aria-label="导入检查统计">
                <span><strong>{bulkImportPreview.counts.total}</strong>{bulkImportPreview.kind === "bundle" ? "文档" : "总计"}</span>
                <span className="is-valid"><strong>{bulkImportPreview.counts.valid}</strong>有效</span>
                <span className="is-duplicate"><strong>{bulkImportPreview.counts.duplicate}</strong>重复</span>
                <span className="is-invalid"><strong>{bulkImportPreview.counts.invalid}</strong>{bulkImportPreview.kind === "bundle" ? "错误" : "无效"}</span>
                {bulkImportPreview.kind === "bundle" && <span className="is-assets"><strong>{bulkImportPreview.counts.assets || 0}</strong>资源</span>}
              </div>

              {bulkImportResult && <div className="bulk-result-summary" role="status">新增 {bulkImportResult.counts.created} · 更新 {bulkImportResult.counts.updated} · 跳过 {bulkImportResult.counts.skipped} · 冲突 {bulkImportResult.counts.conflicts} · 失败 {bulkImportResult.counts.failed}</div>}

              <ol className="bulk-preview-list">
                {bulkImportPreview.items.slice(0, 100).map((item) => {
                  const result = bulkResultById.get(item.id);
                  const status = result ? IMPORT_RESULT_LABEL[result.status] : IMPORT_PREVIEW_LABEL[item.status];
                  return <li key={item.id} className={`is-${result?.status || item.status}`}><span className="bulk-item-index">{item.index + 1}</span><div><strong>{item.label}</strong><small>{result?.error || item.error || item.warnings.join(" · ") || item.sourceUrl || "准备就绪"}</small></div><em>{status}</em></li>;
                })}
              </ol>
              {bulkImportPreview.items.length > 100 && <p className="bulk-list-limit">仅展示前 100 项；其余 {bulkImportPreview.items.length - 100} 项仍会按同一策略处理。</p>}

              <footer className="bulk-dialog-footer">
                {!bulkImportResult ? <>
                  <label><span>遇到重复项</span><select value={bulkImportStrategy} onChange={(event) => setBulkImportStrategy(event.target.value as ImportStrategy)} disabled={bulkImportBusy}><option value="skip">跳过已有（推荐）</option><option value="copy">保留副本</option><option value="update">更新已有（替换内容）</option></select>{bulkImportStrategy === "update" && <small>{bulkImportTouchesDirtyDocument ? "当前打开的重复条目有未保存修改，请先保存或改用其他策略。" : "会用导入内容替换已有正文与组织信息；预检后发生变化的条目会报告冲突。"}</small>}</label>
                  <div><button type="button" onClick={() => void restartBulkImport()} disabled={bulkImportBusy}>重新选择</button><button className="primary-button" type="button" onClick={() => void applyBulkImport()} disabled={bulkImportBusy || bulkImportTouchesDirtyDocument || bulkImportPreview.counts.valid + bulkImportPreview.counts.duplicate === 0}>{bulkImportBusy ? <><Spinner />导入中</> : "确认导入"}</button></div>
                </> : <button className="primary-button" type="button" onClick={() => void closeBulkImport()}>完成</button>}
              </footer>
            </>}
            {bulkImportNotice && <p className="bulk-import-notice" role="status">{bulkImportNotice}</p>}
            {bulkImportError && <p className="bulk-import-error" role="alert">{bulkImportError}</p>}
          </section>
        </dialog>
      )}

      {aiSettingsOpen ? (
        <AiSettings onClose={() => setAiSettingsOpen(false)} />
      ) : safetyOpen ? (
        <DataSafety
          beforeOperation={prepareDataSafetyOperation}
          onClose={() => setSafetyOpen(false)}
          onModeChange={setSafetyRecovery}
        />
      ) : <>
      <section className="capture-band" aria-labelledby="capture-title">
        <div className="capture-index" aria-hidden="true">01</div>
        <div className="capture-copy">
          <h1 id="capture-title">收藏一张网页</h1>
          <p>输入链接，织页会留下正文、来源与可编辑的 Markdown。</p>
          <div className={`queue-control ${captureQueue?.paused ? "is-paused" : ""}`}>
            <span role="status"><i />{queueLabel}</span>
            <button type="button" aria-pressed={captureQueue?.paused || false} onClick={() => void toggleCaptureQueue()} disabled={!captureQueue || queueUpdating || closing}>
              {queueUpdating ? "调整中…" : captureQueue?.paused ? "继续采集" : "暂停采集"}
            </button>
            <button type="button" onClick={() => setBulkImportOpen(true)} disabled={closing || importing}>批量导入</button>
          </div>
          {queueError && <span className="queue-error" role="alert">队列状态不可用：{queueError}</span>}
        </div>
        <form className="capture-form" onSubmit={handleImport}>
          <label className="sr-only" htmlFor="capture-url">网页地址</label>
          <span className="url-prefix" aria-hidden="true">URL</span>
          <input id="capture-url" value={importUrl} onChange={(event) => { setImportUrl(event.target.value); setImportDuplicate(null); setImportError(""); setImportNotice(""); }} placeholder="https://example.com/an-article" inputMode="url" autoComplete="url" disabled={importing || closing || navigationMutationLocked} />
          <button className="primary-button" type="submit" disabled={closing || importing || navigationMutationLocked || !importUrl.trim()}>
            {importing ? <><Spinner />收取中</> : <><span>收取网页</span><Icon><path d="M5 12h14M13 6l6 6-6 6" /></Icon></>}
          </button>
        </form>
        <div className="form-message" aria-live="polite">
          {importError ? <span className="error-text">{importError}</span> : importDuplicate ? (
            <div className="import-duplicate" role="status">
              <span>{importDuplicate.kind === "source" ? "这个网址已经收藏过。" : "这个网址指向已有知识。"}{importDuplicate.document.deletedAt ? " 已有条目在回收站。" : ""}</span>
              <span className="import-duplicate-actions">
                <button type="button" onClick={() => void openImportedDuplicate()} disabled={importing || closing || navigationMutationLocked}>打开已有</button>
                {importDuplicate.kind === "resolved" && <button type="button" onClick={() => void keepImportedDuplicate()} disabled={importing || closing || navigationMutationLocked}>保留两篇</button>}
              </span>
            </div>
          ) : importNotice && <span className="notice-text">{importNotice}</span>}
        </div>
      </section>

      <main className={`workspace ${selectedId ? "has-selection" : ""}`}>
        <aside id="library-panel" className="library-panel" aria-label="知识列表">
          <div className="panel-heading">
            <div><span className="eyebrow">02 · {inTrash ? "TRASH" : "LIBRARY"}</span><h2>{inTrash ? "回收站" : "知识织片"}</h2></div>
            <span className="total-count">{total}<small>篇</small></span>
          </div>

          <nav className="library-tabs" aria-label="资料库视图">
            {([
              ["all", "全部"], ["recent", "最近"], ["favorites", "收藏"], ["unorganized", "未整理"],
              ["archived", "归档"], ["failed", "失败"], ["trash", "回收站"],
            ] as Array<[LibraryView, string]>).map(([value, label]) => (
              <button key={value} type="button" aria-pressed={libraryView === value} onClick={() => applyLibraryView(value)} disabled={listLoading || batchBusy}>{label}</button>
            ))}
          </nav>

          <fieldset className="filters" disabled={listLoading || batchBusy}>
            <label className="search-field">
              <span className="sr-only">搜索知识</span>
              <Icon size={17}><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></Icon>
              <input ref={searchInputRef} aria-keyshortcuts="Meta+K Control+K /" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="搜索标题与正文" />
              {query && <button type="button" className="clear-search" onClick={() => setQuery("")} aria-label="清空搜索">×</button>}
            </label>
            <label className="scope-field"><span>搜索范围</span><select value={searchScope} onChange={(event) => { setSearchScope(event.target.value as SearchScope); setPage(1); }}><option value="all">全部字段</option><option value="title">仅标题</option><option value="body">仅正文</option><option value="source">仅来源</option></select></label>
            <div className="select-row">
              <label><span className="sr-only">按标签筛选</span><select value={tag} onChange={(event) => { setTag(event.target.value); setPage(1); }}><option value="">全部标签</option>{knownTags.map((value) => <option key={value} value={value}>#{value}</option>)}</select></label>
              <label><span className="sr-only">按状态筛选</span><select value={status} onChange={(event) => { setStatus(event.target.value as StatusFilter); setPage(1); }}><option value="">全部状态</option><option value="ready">已就绪</option><option value="queued">等待中</option><option value="fetching">抓取中</option><option value="extracting">整理中</option><option value="failed">抓取失败</option></select></label>
            </div>
            <div className="select-row">
              <label><span className="sr-only">按集合筛选</span><select value={collectionFilter} onChange={(event) => { setCollectionFilter(event.target.value); setPage(1); }}><option value="">全部集合</option>{collections.map((value) => <option key={value.id} value={value.id}>{value.name}</option>)}</select></label>
              <label><span className="sr-only">排序</span><select value={sortOrder} onChange={(event) => { setSortOrder(event.target.value as SortOrder); setPage(1); }}><option value="updated">最近更新</option><option value="created">最近创建</option><option value="title">标题排序</option></select></label>
            </div>
            <details className="advanced-filters">
              <summary>更多筛选</summary>
              <div className="select-row">
                <label><span>收藏</span><select value={favoriteFilter === undefined ? "" : String(favoriteFilter)} onChange={(event) => { setFavoriteFilter(event.target.value === "" ? undefined : event.target.value === "true"); setPage(1); }}><option value="">不限</option><option value="true">已收藏</option><option value="false">未收藏</option></select></label>
                <label><span>归档</span><select value={archivedFilter === undefined ? "" : String(archivedFilter)} onChange={(event) => { setArchivedFilter(event.target.value === "" ? undefined : event.target.value === "true"); setPage(1); }}><option value="">不限</option><option value="true">已归档</option><option value="false">未归档</option></select></label>
              </div>
              <label><span>采集方式</span><select value={captureModeFilter} onChange={(event) => { setCaptureModeFilter(event.target.value as CaptureMode | ""); setPage(1); }}><option value="">不限</option><option value="http">直接读取</option><option value="browser">浏览器采集</option></select></label>
              <div className="date-filter-row"><label><span>起始日期</span><input type="date" value={dateFrom} onChange={(event) => { setDateFrom(event.target.value); setPage(1); }} /></label><label><span>结束日期</span><input type="date" value={dateTo} onChange={(event) => { setDateTo(event.target.value); setPage(1); }} /></label></div>
            </details>
            {!!savedFilters.length && <div className="recent-filters" aria-label="最近筛选"><span>最近</span>{savedFilters.map((saved, index) => <button type="button" key={`${saved.label}-${index}`} onClick={() => applySavedFilter(saved)}>{saved.label}</button>)}</div>}
            {recentFilterNotice && <p className="batch-message" role="status">{recentFilterNotice}</p>}
          </fieldset>

          <div className="result-caption"><span>{filteredDescription}</span>{items.some(needsCapturePolling) && <span className="polling-mark"><i />更新中</span>}</div>

          {!!items.length && <div className="bulk-toolbar" aria-label="当前页批量操作">
            <label><input type="checkbox" disabled={listLoading || batchBusy || itemsContextRef.current !== listContextKey} checked={items.length > 0 && items.every((item) => selectedIds.has(item.id))} onChange={(event) => { if (itemsContextRef.current !== listContextKey) return; selectionContextRef.current = listContextKey; setSelectedIds(event.target.checked ? new Set(items.map((item) => item.id)) : new Set()); }} />选中当前页 <strong>{selectedIds.size}</strong> 篇</label>
            {!!selectedIds.size && <><select aria-label="批量操作" disabled={listLoading || batchBusy} value={batchAction} onChange={(event) => setBatchAction(event.target.value as BatchDocumentAction | "")}><option value="">选择操作</option><option value="add-tag">添加标签</option><option value="remove-tag">移除标签</option><option value="add-collection">加入集合</option><option value="remove-collection">移出集合</option>{inTrash ? <option value="restore">恢复</option> : <><option value="archive">归档</option><option value="unarchive">取消归档</option><option value="trash">删除（移入回收站）</option></>}</select>{(batchAction === "add-collection" || batchAction === "remove-collection") && <select aria-label="批量操作集合" disabled={listLoading || batchBusy} value={batchCollectionId} onChange={(event) => setBatchCollectionId(event.target.value)}><option value="">选择集合</option>{collections.map((value) => <option key={value.id} value={value.id}>{value.name}</option>)}</select>}<button type="button" onClick={() => void runBatchAction()} disabled={listLoading || batchBusy || !batchAction}>{batchBusy ? "处理中…" : "应用"}</button></>}
          </div>}
          {(!inTrash || portableExporting) && <div className="portable-toolbar" aria-label="便携知识包导出">
            <div><strong>便携知识包</strong><span>用于迁移与分享，不等同于可恢复数据库的完整留档。</span><button type="button" onClick={() => setSafetyOpen(true)} disabled={Boolean(portableExporting)}>前往完整留档</button></div>
            <div>
              <button type="button" onClick={() => void exportPortable("selected")} disabled={((listLoading || closing) && portableExporting !== "selected") || (portableExporting !== null && portableExporting !== "selected") || ((!selectedIds.size || inTrash) && portableExporting !== "selected")}>{portableExporting === "selected" ? "取消所选导出" : `导出所选${selectedIds.size ? ` ${selectedIds.size} 篇` : ""}`}</button>
              <button type="button" onClick={() => void exportPortable("all")} disabled={((listLoading || closing) && portableExporting !== "all") || (inTrash && portableExporting !== "all") || (portableExporting !== null && portableExporting !== "all")}>{portableExporting === "all" ? "取消全部导出" : "导出全部"}</button>
            </div>
          </div>}
          {portableNotice && <p className="batch-message" role="status">{portableNotice}</p>}
          {portableError && <p className="batch-message error-text" role="alert">{portableError}</p>}
          {batchNotice && <p className="batch-message" role="status">{batchNotice}</p>}
          {batchError && <p className="batch-message error-text" role="alert">{batchError}</p>}

          <div ref={libraryListRef} className="document-list" onKeyDown={handleListKeyDown}>
            {listLoading && !items.length ? <StatePanel kind="loading" title="正在翻阅知识库" /> : listError ? <StatePanel kind="error" title="无法读取列表">{listError}</StatePanel> : !items.length ? <StatePanel kind="empty" title={inTrash ? "回收站是空的" : "还没有找到织片"}>{query || tag || status ? "试试放宽筛选条件。" : inTrash ? "移除的网页会暂存在这里。" : "从上方收藏第一张网页。"}</StatePanel> : items.map((item, index) => (
              <div key={item.id} className={`document-row-wrap ${selectedId === item.id ? "is-selected" : ""}`}>
                <label className="row-select"><span className="sr-only">选择 {item.title || "未命名网页"}</span><input type="checkbox" disabled={listLoading || batchBusy || itemsContextRef.current !== listContextKey} checked={selectedIds.has(item.id)} onChange={(event) => { if (itemsContextRef.current !== listContextKey) return; selectionContextRef.current = listContextKey; setSelectedIds((previous) => { const next = new Set(previous); if (event.target.checked) next.add(item.id); else next.delete(item.id); return next; }); }} /></label>
                <button type="button" className={`document-row ${selectedId === item.id ? "is-selected" : ""}`} onClick={() => selectDocument(item.id)} aria-current={selectedId === item.id ? "true" : undefined} aria-keyshortcuts="Enter ArrowUp ArrowDown J K X">
                <span className="row-number">{String((page - 1) * pageSize + index + 1).padStart(2, "0")}</span>
                <span className="row-body">
                  <strong>{item.title || "未命名网页"}</strong>
                  <span className="row-source">{sourceName(item.sourceUrl)}<b>·</b>{formatDate(item.updatedAt)}</span>
                  <span className="row-footer">
                    <DocumentStatus status={item.status} />
                    {item.favorite && <span className="favorite-mark" aria-label="已收藏">★</span>}
                    {item.archivedAt && <em className="archived-mark">已归档</em>}
                    {item.collections.slice(0, 1).map((value) => <em className="collection-mark" key={value.id}>{value.name}</em>)}
                    {item.tags.slice(0, 2).map((value) => <em key={value}>#{value}</em>)}
                  </span>
                </span>
                <span className="row-arrow" aria-hidden="true">↗</span>
                </button>
              </div>
            ))}
          </div>

          {pageCount > 1 && <nav className="pagination" aria-label="知识列表分页"><button type="button" disabled={listLoading || batchBusy || page <= 1} onClick={() => setPage((value) => value - 1)}>上一页</button><span>{page} / {pageCount}</span><button type="button" disabled={listLoading || batchBusy || page >= pageCount} onClick={() => setPage((value) => value + 1)}>下一页</button></nav>}
        </aside>

        <section id="reader-panel" ref={readerPanelRef} className="reader-panel" aria-label="文档工作台" tabIndex={-1}>
          {!selectedId ? (
            <div className="welcome-state">
              <div className="weave-mark" aria-hidden="true"><i /><i /><i /><i /></div>
              <span className="eyebrow">QUIET WORKBENCH</span>
              <h2>在左侧选一张织片</h2>
              <p>阅读原文、整理标签，或直接修改 Markdown。<br />你的文字会留在本地。</p>
            </div>
          ) : detailLoading && !currentDoc ? (
            <StatePanel kind="loading" title="正在展开织片" />
          ) : detailError && !currentDoc ? (
            <StatePanel kind="error" title="无法打开这篇知识">{detailError}</StatePanel>
          ) : currentDoc && draft ? (
            <>
              <button type="button" className="mobile-back" onClick={closeDocument}><Icon size={16}><path d="m15 18-6-6 6-6" /></Icon>返回知识库</button>
              <header className="document-head">
                <div className="document-kicker">
                  <DocumentStatus status={currentDoc.status} />
                  <a href={currentDoc.finalUrl || currentDoc.sourceUrl} target="_blank" rel="noreferrer noopener">{sourceName(currentDoc.finalUrl || currentDoc.sourceUrl)}<Icon size={13}><path d="M14 5h5v5M10 14 19 5M19 14v5H5V5h5" /></Icon></a>
                  <span>{formatDate(currentDoc.updatedAt)}</span>
                  {currentDoc.archivedAt && <span className="archive-stamp">已归档</span>}
                </div>
                <label className="title-field"><span className="sr-only">文档标题</span><textarea rows={2} value={draft.title} onChange={(event) => { if (!closeAttemptRef.current) setDraft({ ...draft, title: event.target.value }); }} disabled={Boolean(currentDoc.deletedAt) || currentDoc.status !== "ready" || editorLocked} /></label>
                <div className="document-meta">
                  <label className="tag-field"><span>标签</span><input value={tagText} onChange={(event) => { if (!closeAttemptRef.current) { setTagText(event.target.value); setDraft({ ...draft, tags: parseTags(event.target.value) }); } }} placeholder="用逗号分隔" disabled={Boolean(currentDoc.deletedAt) || currentDoc.status !== "ready" || editorLocked} /></label>
                  <fieldset className="collection-picker" disabled={organizationLocked || metadataDirty}>
                    <legend>集合</legend>
                    <div>
                      {collectionsLoading && !collections.length ? <span>读取中…</span> : !collections.length ? <span>尚未创建</span> : collections.map((collection) => (
                        <label key={collection.id}>
                          <input
                            type="checkbox"
                            checked={currentDoc.collections.some((value) => value.id === collection.id)}
                            onChange={(event) => void toggleDocumentCollection(collection.id, event.target.checked)}
                          />
                          {collection.name}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                </div>
                {sourceMetadata && (
                  <form className="source-metadata-form" aria-label="来源信息" onSubmit={saveSourceMetadata}>
                    <label><span>作者</span><input aria-label="作者" maxLength={1000} value={sourceMetadata.author} onChange={(event) => { setSourceMetadata({ ...sourceMetadata, author: event.target.value }); setOrganizationNotice(""); setOrganizationError(""); }} placeholder="未识别" disabled={organizationLocked} /></label>
                    <label><span>发布日期</span><input aria-label="发布日期" type="date" value={sourceMetadata.publishedDate} onChange={(event) => { setSourceMetadata({ ...sourceMetadata, publishedDate: event.target.value }); setOrganizationNotice(""); setOrganizationError(""); }} disabled={organizationLocked} /></label>
                    <label className="source-note-field"><span>来源备注</span><textarea aria-label="来源备注" maxLength={50_000} rows={2} value={sourceMetadata.sourceNote} onChange={(event) => { setSourceMetadata({ ...sourceMetadata, sourceNote: event.target.value }); setOrganizationNotice(""); setOrganizationError(""); }} placeholder="记下收录背景、可信度或阅读线索" disabled={organizationLocked} /></label>
                    <div className="source-metadata-save">
                      <span>收取·{currentDoc.captureMode === "browser" ? "浏览器" : currentDoc.captureMode === "http" ? "直接读取" : "—"}</span>
                      <button type="submit" disabled={organizationLocked || !metadataDirty}>{organizationSaving ? "保存中…" : "保存来源信息"}</button>
                    </div>
                  </form>
                )}
                <div className="document-actions">
                  <button type="button" className={`favorite-button ${currentDoc.favorite ? "is-active" : ""}`} aria-pressed={currentDoc.favorite} onClick={() => void toggleFavorite()} disabled={organizationLocked || metadataDirty}>{currentDoc.favorite ? "★ 取消收藏" : "☆ 设为收藏"}</button>
                  <button type="button" className="history-button" onClick={() => void toggleArchive()} disabled={organizationLocked || metadataDirty}>{currentDoc.archivedAt ? "取消归档" : "归档"}</button>
                  <button type="button" className="history-button" onClick={toggleCollectionManager} disabled={closing} aria-expanded={collectionsOpen} aria-controls="collection-manager">管理分类</button>
                  <button type="button" className="history-button" onClick={toggleQuality} disabled={closing || currentDoc.status !== "ready"} aria-expanded={qualityOpen} aria-controls="capture-quality">质量检查</button>
                  <button type="button" className="history-button" onClick={toggleCaptureHistory} disabled={closing} aria-expanded={captureHistoryOpen} aria-controls="capture-history">采集历史</button>
                  <button type="button" className="history-button" onClick={toggleDerived} disabled={closing} aria-expanded={derivedOpen} aria-controls="derived-knowledge">AI 派生</button>
                  {!currentDoc.deletedAt && (
                    <button type="button" className="text-button danger" onClick={() => void moveToTrash()} disabled={closing || organizationSaving || Boolean(organizationConflict) || Boolean(remoteDraftConflict) || Boolean(lifecycleAction) || hasUnsavedChanges || saveState === "saving"} title={hasUnsavedChanges || remoteDraftConflict || organizationConflict ? "请先处理当前更改" : undefined}>
                      {lifecycleAction === "delete" ? "正在移除…" : "移入回收站"}
                    </button>
                  )}
                </div>
              </header>

              {collectionsOpen && (
                <aside id="collection-manager" className="collection-manager" aria-label="集合管理">
                  <header><div><span className="eyebrow">CLASSIFICATION INDEX</span><h3>管理集合与标签</h3></div><button type="button" onClick={() => setCollectionsOpen(false)} aria-label="关闭分类管理">×</button></header>
                  <h4>集合</h4>
                  <form className="collection-create" onSubmit={createCollection}>
                    <label><span className="sr-only">新集合名称</span><input aria-label="新集合名称" maxLength={100} value={collectionName} onChange={(event) => setCollectionName(event.target.value)} placeholder="新集合名称" disabled={organizationLocked || metadataDirty} /></label>
                    <button type="submit" className="primary-button" disabled={organizationLocked || metadataDirty || !collectionName.trim()}>{collectionAction === "create" ? "创建中…" : "创建集合"}</button>
                  </form>
                  {collectionsLoading && !collections.length ? <StatePanel kind="loading" title="正在读取集合" /> : !collections.length ? <p className="collection-empty">用集合把不同来源的知识放进同一个主题。</p> : (
                    <ul>
                      {collections.map((collection) => (
                        <li key={collection.id}>
                          {renamingCollection?.id === collection.id ? (
                            <form className="collection-rename" onSubmit={renameCollection}>
                              <label><span className="sr-only">集合名称</span><input aria-label="集合名称" maxLength={100} value={renamingCollection.name} onChange={(event) => setRenamingCollection({ id: collection.id, name: event.target.value })} autoFocus /></label>
                              <button type="submit" disabled={Boolean(collectionAction) || !renamingCollection.name.trim()}>保存名称</button>
                              <button type="button" onClick={() => setRenamingCollection(null)}>取消</button>
                            </form>
                          ) : (
                            <><div><strong>{collection.name}</strong><span>{collection.documentCount} 篇知识</span></div><div><button type="button" onClick={() => setRenamingCollection({ id: collection.id, name: collection.name })} disabled={organizationLocked || metadataDirty} aria-label={`重命名 ${collection.name}`}>重命名</button><button type="button" onClick={() => void mergeCollection(collection)} disabled={organizationLocked || metadataDirty} aria-label={`合并 ${collection.name}`}>合并</button><button type="button" className="danger" onClick={() => void deleteCollection(collection)} disabled={organizationLocked || metadataDirty} aria-label={`删除 ${collection.name}`}>删除</button></div></>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  <h4>标签</h4>
                  {!managedTags.length ? <p className="collection-empty">还没有标签。</p> : <ul className="tag-manager-list">{managedTags.map((tagValue) => <li key={tagValue.name}><div><strong>#{tagValue.name}</strong><span>{tagValue.documentCount} 篇知识</span></div><div><button type="button" onClick={() => void renameTag(tagValue)} disabled={Boolean(tagAction) || organizationLocked}>重命名</button><button type="button" onClick={() => void mergeTag(tagValue)} disabled={Boolean(tagAction) || organizationLocked}>合并</button><button type="button" className="danger" onClick={() => void deleteTag(tagValue)} disabled={Boolean(tagAction) || organizationLocked}>删除</button></div></li>)}</ul>}
                </aside>
              )}

              {currentDoc.warning && <div className="notice warning" role="status"><strong>注意</strong><span>{currentDoc.warning}</span></div>}
              {organizationNotice && <div className="notice organization-notice" role="status"><strong>已更新</strong><span>{organizationNotice}</span></div>}
              {organizationError && !organizationConflict && <div className="notice error" role="alert"><strong>组织信息未保存</strong><span>{organizationError}</span></div>}
              {assetError && <div className="notice error" role="alert"><strong>离线图片状态不可用</strong><span>{assetError}。预览不会连接原站。</span></div>}
              {draftNotice && <div className="notice warning" role="status"><strong>草稿恢复</strong><span>{draftNotice}</span></div>}
              {draftError && <div className="notice error" role="alert"><strong>草稿未保存</strong><span>{draftError}</span></div>}
              {detailError && <div className="notice error" role="alert"><strong>请求失败</strong><span>{detailError}</span></div>}
              {duplicateError && <div className="notice error" role="alert"><strong>重复检测不可用</strong><span>{duplicateError}</span></div>}
              {duplicateNotice && <div className="notice warning" role="status"><strong>重复知识</strong><span>{duplicateNotice}</span></div>}
              {resolvedDuplicate && <div className="conflict-banner duplicate-banner" role="alert"><div><strong>发现另一篇相同来源的知识</strong><span>已有条目“{resolvedDuplicate.title || "未命名网页"}”{resolvedDuplicate.deletedAt ? "在回收站中" : "仍在资料库中"}。你可以打开已有条目，或明确保留两篇；当前条目不会自动删除。</span></div><div><button type="button" onClick={() => void openResolvedDuplicate()} disabled={closing || navigationMutationLocked}>打开已有</button><button type="button" className="primary-button" onClick={keepResolvedDuplicate} disabled={closing || navigationMutationLocked}>保留两篇</button></div></div>}
              {organizationConflict && <div className="conflict-banner" role="alert"><div><strong>来源或组织信息已在别处更新</strong><span>你的这次操作尚未覆盖服务端数据。可基于最新修订重试，或放弃这次更改。</span></div><div><button type="button" onClick={discardOrganizationUpdate} disabled={closing || organizationSaving}>放弃更改</button><button type="button" className="primary-button" onClick={() => void retryOrganizationUpdate()} disabled={closing || organizationSaving}>{organizationSaving ? "重试中…" : "基于新版重试"}</button></div></div>}
              {qualityOpen && (
                <aside id="capture-quality" className="quality-panel" aria-label="提取质量检查">
                  <header><div><span className="eyebrow">CAPTURE QUALITY</span><h3>提取质量</h3></div><button type="button" onClick={() => setQualityOpen(false)} aria-label="关闭提取质量">×</button></header>
                  {qualityIssues.length ? <ul>{qualityIssues.map((issue) => <li key={issue.title}><strong>{issue.title}</strong><span>{issue.detail}</span></li>)}</ul> : <div className="quality-ok"><i aria-hidden="true">✓</i><div><strong>未发现明显问题</strong><span>标题、正文长度与离线图片状态均通过基础检查。</span></div></div>}
                  <button type="button" className="history-button" onClick={toggleCaptureHistory}>查看采集历史与本地快照</button>
                </aside>
              )}
              {remoteDraftConflict && <div className="conflict-banner" role="alert"><div><strong>草稿在另一窗口发生了变化</strong><span>{remoteDraftConflict.remote ? "你的当前编辑仍在内存中，可以显式保留，或切换到另一窗口的草稿。" : "另一窗口已放弃草稿；你可保留当前编辑，或恢复正式版本。"}</span></div><div><button type="button" onClick={useRemoteDraft} disabled={closing || saveState === "saving"}>{remoteDraftConflict.remote ? "使用另一窗口草稿" : "恢复正式版本"}</button><button type="button" className="primary-button" onClick={() => void keepLocalDraft()} disabled={closing || saveState === "saving"}>{saveState === "saving" ? "处理中…" : "保留我的草稿"}</button></div></div>}
              {conflict && <div className="conflict-banner" role="alert"><div><strong>{conflict.deletedAt ? "这篇知识已被移入回收站" : "这篇知识在别处被修改过"}</strong><span>{conflict.deletedAt ? "可接受回收站状态，或恢复文档后保存你的本地修改。" : "选择保留服务器新版，或基于新版继续保存你的文字。"}</span></div><div><button type="button" onClick={() => void acceptServerVersion()} disabled={closing || Boolean(remoteDraftConflict) || saveState === "saving"}>{conflict.deletedAt ? "查看回收站版本" : "使用新版"}</button><button type="button" className="primary-button" onClick={() => void keepLocalVersion()} disabled={closing || Boolean(remoteDraftConflict) || saveState === "saving"}>{saveState === "saving" ? "处理中…" : "保留我的修改"}</button></div></div>}
              {captureHistoryOpen && (
                <CaptureHistoryPanel
                  document={currentDoc}
                  blockedReason={captureBlockedReason}
                  onClose={() => setCaptureHistoryOpen(false)}
                  onApply={applyReextraction}
                />
              )}
              <DerivedKnowledge
                document={currentDoc}
                open={derivedOpen}
                onClose={() => setDerivedOpen(false)}
                generationBlockedReason={derivedBlockedReason}
                onAdoptTags={adoptDerivedTags}
              />

              {currentDoc.deletedAt ? (
                <div className="trash-workbench">
                  <div className="trash-callout">
                    <div><span className="eyebrow">READ ONLY · {formatDateTime(currentDoc.deletedAt)}</span><h3>这张织片在回收站中</h3><p>正文与历史版本仍完整保留。恢复后才能继续编辑。</p></div>
                    <div className="trash-actions">
                      <button type="button" className="primary-button" onClick={() => void restoreFromTrash()} disabled={closing || importing || Boolean(lifecycleAction)}>{lifecycleAction === "restore" ? <><Spinner />恢复中</> : "恢复到资料库"}</button>
                      <button type="button" className="text-button danger" onClick={() => void permanentlyDelete()} disabled={closing || organizationSaving || Boolean(lifecycleAction) || hasUnsavedChanges || Boolean(conflict) || Boolean(organizationConflict) || Boolean(remoteDraftConflict)} title={hasUnsavedChanges || conflict || organizationConflict || remoteDraftConflict ? "请先处理当前更改" : undefined}>{lifecycleAction === "permanent" ? "删除中…" : "永久删除"}</button>
                    </div>
                  </div>
                  <section className="trash-preview" aria-label="回收站文档预览">
                    <div className="pane-label">READ ONLY</div>
                    {!longPreviewAllowed ? <StatePanel kind="empty" title="长文预览已暂停"><button type="button" onClick={() => setLongPreviewDocumentId(currentDoc.id)}>仍然预览</button></StatePanel> : draft.markdown.trim() ? <MarkdownPreview markdown={draft.markdown} sourceUrl={currentDoc.finalUrl || currentDoc.sourceUrl} assets={assets} /> : <StatePanel kind="empty" title="这张织片没有正文" />}
                  </section>
                </div>
              ) : activeCapture ? (
                <div className="capture-progress" aria-live="polite">
                  <div className="progress-orbit"><i /><i /><span>织</span></div>
                  <span className="eyebrow">{currentDoc.status === "queued" && captureQueue?.paused ? "PAUSED" : currentDoc.status.toUpperCase()}</span>
                  <h3>{currentDoc.status === "queued" && captureQueue?.paused ? "等待继续采集" : STATUS_LABEL[currentDoc.status]}</h3>
                  <p>{currentDoc.status === "queued" && captureQueue?.paused ? "采集队列已暂停。你可以继续队列，或取消这项等待任务。" : "这通常只需片刻。你可以去看其他织片，完成后会自动刷新。"}</p>
                  {!(currentDoc.status === "queued" && captureQueue?.paused) && <div className="progress-line"><span /></div>}
                  {currentDoc.status === "queued" && <button type="button" className="text-button danger" onClick={() => void cancelCapture()} disabled={cancelling || closing}>{cancelling ? "取消中…" : "取消等待"}</button>}
                </div>
              ) : currentDoc.status === "failed" ? (
                <div className="capture-failed" role="alert">
                  <span className="failure-code">{currentDoc.errorCode || "CAPTURE_FAILED"}</span>
                  <h3>这张网页没有收进来</h3>
                  <p>{currentDoc.errorMessage || "请检查链接后再试一次。"}</p>
                  <button type="button" className="primary-button" onClick={retryCapture} disabled={retrying}>{retrying ? <><Spinner />重试中</> : "重新抓取"}</button>
                </div>
              ) : (
                <>{!longPreviewAllowed && <div className="notice warning" role="status"><strong>长文模式</strong><span>正文较长，已默认暂停预览以保持编辑流畅；需要时可手动切换到预览。</span></div>}<div className="editor-workbench">
                  <div className="editor-toolbar">
                    <div className="mode-switch" aria-label="编辑器显示模式">
                      {(["edit", "split", "preview"] as EditorMode[]).map((value) => <button key={value} type="button" aria-pressed={mode === value} onClick={() => { if (longArticle && value !== "edit") setLongPreviewDocumentId(currentDoc.id); setMode(value); }}>{value === "edit" ? "编辑" : value === "split" ? "对照" : "预览"}</button>)}
                    </div>
                    <div className="editor-stats">{draft.markdown.length.toLocaleString("zh-CN")} 字符</div>
                    <div className={`save-indicator save-${saveState}`} aria-live="polite">
                      {saveState === "saving" ? <><Spinner />正在保存</> : saveState === "saved" ? "已保存" : saveState === "error" ? "保存失败" : saveState === "conflict" ? "版本冲突" : dirty ? "未保存" : "已同步"}
                    </div>
                    {saveState === "error" && <button type="button" className="text-button danger" onClick={() => void saveNow()} disabled={closing}>重试</button>}
                    <button type="button" className="text-button save-button" aria-keyshortcuts="Meta+S Control+S" onClick={() => void saveNow()} disabled={closing || !dirty || saveState === "saving" || saveState === "conflict"} title="保存（⌘S）">保存</button>
                    <button type="button" className="history-button" onClick={() => void toggleHistory()} disabled={closing || organizationSaving || hasUnsavedChanges || saveState === "saving"} aria-expanded={historyOpen} aria-controls="revision-history">修订历史</button>
                    <a className="export-button" href={api.exportUrl(currentDoc.id)} download><Icon size={15}><path d="M12 3v12M7 10l5 5 5-5M5 20h14" /></Icon>导出 .md</a>
                  </div>

                  {saveState === "error" && <div className="inline-error" role="alert">{saveError}</div>}
                  {historyOpen && (
                    <aside id="revision-history" className="revision-panel" aria-label="修订历史">
                      <header><div><span className="eyebrow">VERSION THREAD</span><h3>修订历史</h3></div><button type="button" onClick={() => setHistoryOpen(false)} aria-label="关闭修订历史">×</button></header>
                      {historyLoading ? <StatePanel kind="loading" title="正在查找历史版本" /> : historyError ? <StatePanel kind="error" title="无法读取修订历史">{historyError}</StatePanel> : !revisions.length ? <StatePanel kind="empty" title="还没有修订记录">人工编辑并保存后，版本会出现在这里。</StatePanel> : (
                        <ol>
                          {revisions.map((revision) => {
                            const isCurrent = revision.revision === currentDoc.revision;
                            return <li key={revision.revision} className={isCurrent ? "is-current" : undefined}><div className="revision-meta"><strong>版本 {revision.revision}</strong><time dateTime={revision.createdAt}>{formatDateTime(revision.createdAt)}</time></div><h4>{revision.title || "未命名网页"}</h4><p>{revisionPreview(revision.markdown)}</p><div className="revision-foot"><span>{revision.tags.length ? revision.tags.map((value) => `#${value}`).join(" ") : "无标签"}</span><button type="button" onClick={() => void restoreRevision(revision)} disabled={isCurrent || importing || hasUnsavedChanges || restoringRevision !== null}>{isCurrent ? "当前版本" : restoringRevision === revision.revision ? "恢复中…" : "恢复此版本"}</button></div></li>;
                          })}
                        </ol>
                      )}
                    </aside>
                  )}

                  <div className={`editor-grid mode-${mode}`}>
                    {mode !== "preview" && <section className="editor-pane" aria-label="Markdown 源文编辑"><div className="pane-label">MARKDOWN</div><MarkdownEditor value={draft.markdown} onChange={(markdown) => { if (!closeAttemptRef.current) setDraft((value) => value ? { ...value, markdown } : value); }} readOnly={editorLocked} /></section>}
                    {mode !== "edit" && longPreviewAllowed && <section className="preview-pane" aria-label="Markdown 预览"><div className="pane-label">PREVIEW</div>{draft.markdown.trim() ? <MarkdownPreview markdown={draft.markdown} sourceUrl={currentDoc.finalUrl || currentDoc.sourceUrl} assets={assets} /> : <StatePanel kind="empty" title="这里还没有文字">在编辑区写下 Markdown，预览会同步出现。</StatePanel>}</section>}
                  </div>
                </div></>
              )}
            </>
          ) : null}
        </section>
      </main>
      </>}
    </div>
  );
}
