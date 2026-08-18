import { useCallback, useEffect, useRef, useState } from "react";
import type { DragEvent, KeyboardEventHandler, ReactNode, Ref } from "react";

import type { DocumentFilters, DocumentSummary, KnowledgeFolder } from "../../shared/types";
import { api } from "../api";
import { Button, IconButton, Select } from "./ui/Controls";
import { useDialogs, useToast } from "./ui/Feedback";
import { Modal } from "./ui/Modal";
import { HoverCard } from "./ui/Tooltip";

export interface MoveDocumentTarget {
  folderId: string | null;
  id: string;
  revision: number;
}

const DRAG_TYPE = "application/x-zhiye-document";
const STATUS: Record<DocumentSummary["status"], string> = {
  queued: "等待抓取", fetching: "正在读取", extracting: "正在整理", ready: "已就绪", failed: "抓取失败",
};

function host(url: string) {
  try { return new URL(url).hostname.replace(/^www\./u, "") || "本地导入"; } catch { return "本地导入"; }
}

function date(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric" }).format(new Date(value));
}

export function DocumentDirectoryRow({
  document,
  folders,
  selected,
  checkbox,
  onOpen,
  onMove,
}: {
  document: DocumentSummary;
  folders: KnowledgeFolder[];
  selected?: boolean;
  checkbox?: ReactNode;
  onOpen: (id: string) => void;
  onMove: (document: MoveDocumentTarget, folderId: string | null) => Promise<void>;
}) {
  const [moveOpen, setMoveOpen] = useState(false);
  const [targetFolder, setTargetFolder] = useState(document.folderId ?? "");
  const [moving, setMoving] = useState(false);
  const externalUrl = document.finalUrl || document.sourceUrl;
  const folderName = folders.find(({ id }) => id === document.folderId)?.name ?? "根目录";
  const draggable = !document.deletedAt && !matchMedia("(hover: none), (pointer: coarse)").matches;
  const target = { id: document.id, revision: document.revision, folderId: document.folderId };

  const move = async () => {
    const folderId = targetFolder || null;
    if (folderId === document.folderId) { setMoveOpen(false); return; }
    setMoving(true);
    try { await onMove(target, folderId); setMoveOpen(false); }
    finally { setMoving(false); }
  };

  const detail = <div className="directory-hover-detail">
    <strong>{document.title || "未命名网页"}</strong>
    <span>{host(externalUrl)} · {externalUrl}</span>
    {document.author && <span>作者 · {document.author}</span>}
    <span>文件夹 · {folderName}</span>
    <span>状态 · {STATUS[document.status]}{document.favorite ? " · 已收藏" : ""}{document.archivedAt ? " · 已归档" : ""}</span>
    {!!document.tags.length && <span>{document.tags.slice(0, 5).map((tag) => `#${tag}`).join(" ")}{document.tags.length > 5 ? ` · 另 ${document.tags.length - 5} 个` : ""}</span>}
    <span>创建 {date(document.createdAt)} · 更新 {date(document.updatedAt)}</span>
  </div>;

  return <div
    className={`directory-document-row document-row-wrap ${selected ? "is-selected" : ""} ${moving ? "is-moving" : ""}`}
    draggable={draggable && !moving}
    onDragStart={(event) => {
      if (matchMedia("(hover: none), (pointer: coarse)").matches) { event.preventDefault(); return; }
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(target));
    }}
  >
    {checkbox ?? <span className="directory-checkbox-space" aria-hidden="true" />}
    <span className={`directory-status is-${document.status}`} aria-label={STATUS[document.status]} />
    <span className="sr-only">{STATUS[document.status]}</span>
    <HoverCard content={detail} delay={1_000} disabled={matchMedia("(hover: none), (pointer: coarse)").matches} label="知识详细信息">
      <button type="button" className="directory-title document-row" aria-current={selected ? "true" : undefined} onClick={() => onOpen(document.id)}>{document.title || "未命名网页"}</button>
    </HoverCard>
    {/^(?:https?):/u.test(externalUrl) ? <a className="directory-external" href={externalUrl} target="_blank" rel="noreferrer noopener" aria-label={`打开原网页：${document.title || "未命名网页"}`}>↗</a> : <span className="directory-external-space" aria-hidden="true" />}
    {!document.deletedAt && <IconButton label={`移动 ${document.title || "未命名网页"}`} onClick={() => { setTargetFolder(document.folderId ?? ""); setMoveOpen(true); }}>•••</IconButton>}
    {moveOpen && <ModalMove
      folders={folders}
      moving={moving}
      targetFolder={targetFolder}
      setTargetFolder={setTargetFolder}
      onClose={() => setMoveOpen(false)}
      onMove={() => void move()}
    />}
  </div>;
}

function ModalMove({ folders, moving, targetFolder, setTargetFolder, onClose, onMove }: {
  folders: KnowledgeFolder[];
  moving: boolean;
  targetFolder: string;
  setTargetFolder: (value: string) => void;
  onClose: () => void;
  onMove: () => void;
}) {
  return <Modal open title="移动到文件夹" dismissible={!moving} onClose={onClose} footer={<>
    <Button onClick={onClose} disabled={moving}>取消</Button><Button variant="primary" onClick={onMove} disabled={moving}>{moving ? "移动中…" : "移动"}</Button>
  </>}>
    <label className="directory-move-field"><span>目标位置</span><Select autoFocus value={targetFolder} onChange={(event) => setTargetFolder(event.target.value)}><option value="">根目录</option>{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</Select></label>
  </Modal>;
}

interface Branch {
  context: string;
  error: string;
  items: DocumentSummary[];
  loading: boolean;
  page: number;
  pageSize: number;
  total: number;
}

export function LibraryDirectory({
  folders,
  filters,
  refreshKey,
  onFoldersChanged,
  onOpen,
  onMove,
  selectedId,
  selectedIds,
  selectionDisabled,
  listRef,
  onListKeyDown,
  onSelect,
  activeFolderId,
}: {
  folders: KnowledgeFolder[];
  filters: Omit<DocumentFilters, "folderId" | "unfiled" | "page" | "trash">;
  refreshKey: number;
  onFoldersChanged: () => void;
  onOpen: (id: string) => void;
  onMove: (document: MoveDocumentTarget, folderId: string | null) => Promise<void>;
  selectedId?: string | null;
  selectedIds?: ReadonlySet<string>;
  selectionDisabled?: boolean;
  listRef?: Ref<HTMLDivElement>;
  onListKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  onSelect?: (document: DocumentSummary, checked: boolean) => void;
  activeFolderId?: string | null;
}) {
  const dialogs = useDialogs();
  const toast = useToast();
  const [expanded, setExpanded] = useState<string[]>([]);
  const [branches, setBranches] = useState<Record<string, Branch>>({});
  const controllers = useRef(new Map<string, AbortController>());
  const filterKey = JSON.stringify(filters);
  const hasFilters = Object.entries(filters).some(([key, value]) => key !== "sort" && key !== "scope" && value !== undefined && value !== "");

  const loadBranch = useCallback(async (key: string, page = 1) => {
    controllers.current.get(key)?.abort();
    const controller = new AbortController();
    controllers.current.set(key, controller);
    setBranches((current) => ({ ...current, [key]: { ...(current[key] ?? { items: [], total: 0, pageSize: 30 }), context: filterKey, page, loading: true, error: "" } }));
    try {
      const result = await api.listDocuments({ ...filters, page, ...(key === "unfiled" ? { unfiled: true } : { folderId: key }) }, controller.signal);
      if (!controller.signal.aborted) setBranches((current) => ({ ...current, [key]: { ...result, context: filterKey, loading: false, error: "" } }));
    } catch (error) {
      if ((error as Error).name !== "AbortError") setBranches((current) => ({ ...current, [key]: { ...(current[key] ?? { items: [], total: 0, page, pageSize: 30 }), context: filterKey, loading: false, error: (error as Error).message } }));
    }
  }, [filterKey]);

  useEffect(() => {
    void loadBranch("unfiled", 1);
    for (const key of expanded) void loadBranch(key, 1);
    return () => { for (const controller of controllers.current.values()) controller.abort(); };
  }, [filterKey, refreshKey]);

  const polling = ["unfiled", ...expanded].filter((key) => branches[key]?.items.some((item) => ["queued", "fetching", "extracting"].includes(item.status)));
  const pollingKey = polling.map((key) => `${key}:${branches[key]?.page ?? 1}`).join("\0");
  useEffect(() => {
    if (!polling.length) return;
    const timer = window.setInterval(() => {
      for (const key of polling) void loadBranch(key, branches[key]?.page ?? 1);
    }, 2_500);
    return () => window.clearInterval(timer);
  }, [pollingKey, loadBranch]);

  const toggle = (key: string) => {
    if (expanded.includes(key)) {
      controllers.current.get(key)?.abort();
      controllers.current.delete(key);
      setBranches((values) => { const next = { ...values }; delete next[key]; return next; });
      setExpanded(expanded.filter((value) => value !== key));
      return;
    }
    const next = [...expanded, key];
    if (next.length > 6) {
      const removed = next.shift();
      if (removed) {
        controllers.current.get(removed)?.abort();
        controllers.current.delete(removed);
        setBranches((values) => { const retained = { ...values }; delete retained[removed]; return retained; });
      }
      toast.success("已自动收起最早打开的文件夹，最多同时展开 6 个。");
    }
    setExpanded(next);
    void loadBranch(key, branches[key]?.page ?? 1);
  };

  useEffect(() => {
    if (!selectedId || activeFolderId === undefined) return;
    if (activeFolderId === null) return;
    const key = activeFolderId;
    if (!expanded.includes(key)) toggle(key);
  }, [activeFolderId, selectedId]);

  const createFolder = async () => {
    const name = (await dialogs.prompt("创建一个新的一级文件夹。", { title: "新建文件夹", label: "文件夹名称", confirmLabel: "创建", maxLength: 100 }))?.trim();
    if (!name) return;
    try { await api.createFolder(name); toast.success(`已创建文件夹“${name}”。`); onFoldersChanged(); }
    catch (error) { toast.error((error as Error).message); }
  };

  const renameFolder = async (folder: KnowledgeFolder) => {
    const name = (await dialogs.prompt(`重命名“${folder.name}”。`, { title: "重命名文件夹", label: "文件夹名称", initialValue: folder.name, confirmLabel: "保存", maxLength: 100 }))?.trim();
    if (!name || name === folder.name) return;
    try { await api.updateFolder(folder.id, name); toast.success(`已更名为“${name}”。`); onFoldersChanged(); }
    catch (error) { toast.error((error as Error).message); }
  };

  const deleteFolder = async (folder: KnowledgeFolder) => {
    if (!await dialogs.confirm(`删除“${folder.name}”？其中 ${folder.documentCount} 篇知识会保留并移到“根目录”。`, { title: "删除文件夹", confirmLabel: "删除文件夹", tone: "danger" })) return;
    try { await api.deleteFolder(folder.id); setExpanded((current) => current.filter((key) => key !== folder.id)); toast.success(`已删除“${folder.name}”，知识仍保留。`); onFoldersChanged(); }
    catch (error) { toast.error((error as Error).message); }
  };

  const drop = async (event: DragEvent, folderId: string | null) => {
    event.preventDefault();
    try {
      const value = JSON.parse(event.dataTransfer.getData(DRAG_TYPE)) as MoveDocumentTarget;
      if (!value?.id || value.folderId === folderId) return;
      await onMove(value, folderId);
    } catch { toast.error("无法识别拖动的知识，请使用“移动到…”操作。"); }
  };

  const root = branches.unfiled;
  return <section className="library-directory" aria-labelledby="folder-directory-title">
    <header><div><span>FOLDERS</span><h3 id="folder-directory-title">文件夹</h3></div><IconButton label="新建文件夹" onClick={() => void createFolder()}>＋</IconButton></header>
    <div ref={listRef} className="folder-tree" onKeyDown={onListKeyDown}>
      <div className="root-contents" role="region" aria-label="根目录内容" onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }} onDrop={(event) => void drop(event, null)}>
        {root?.loading && !root.items.length ? <p role="status">正在读取…</p> : root?.error ? <p role="alert">{root.error}</p> : !root?.items.length ? <p>{hasFilters ? "没有符合筛选条件的顶层知识。" : "暂无未归入文件夹的知识。"}</p> : root.items.map((document) => <DocumentDirectoryRow
          key={document.id}
          document={document}
          folders={folders}
          selected={selectedId === document.id}
          onOpen={onOpen}
          onMove={onMove}
          checkbox={onSelect ? <label className="row-select"><span className="sr-only">选择 {document.title || "未命名网页"}</span><input type="checkbox" disabled={selectionDisabled || root.loading || root.context !== filterKey} checked={selectedIds?.has(document.id) ?? false} onChange={(event) => onSelect(document, event.target.checked)} /></label> : undefined}
        />)}
        {root && root.total > root.pageSize && <nav className="folder-pagination" aria-label="根目录分页"><button type="button" disabled={root.loading || root.page <= 1} onClick={() => void loadBranch("unfiled", root.page - 1)}>上一页</button><span>{root.page} / {Math.ceil(root.total / root.pageSize)}</span><button type="button" disabled={root.loading || root.page * root.pageSize >= root.total} onClick={() => void loadBranch("unfiled", root.page + 1)}>下一页</button></nav>}
      </div>
      {folders.map((folder) => {
        const key = folder.id;
        const open = expanded.includes(key);
        const branch = branches[key];
        return <section key={key} className={`folder-branch ${open ? "is-open" : ""}`}>
          <div className="folder-node" onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }} onDrop={(event) => void drop(event, key)}>
            <button type="button" aria-expanded={open} onClick={() => toggle(key)}><span aria-hidden="true">{open ? "▾" : "▸"}</span><b aria-hidden="true">▱</b><strong>{folder.name}</strong><em>{branch?.total ?? (hasFilters ? "—" : folder.documentCount)}</em></button>
            <div><IconButton label={`重命名 ${folder.name}`} onClick={() => void renameFolder(folder)}>✎</IconButton><IconButton label={`删除 ${folder.name}`} onClick={() => void deleteFolder(folder)}>×</IconButton></div>
          </div>
          {open && <div className="folder-contents">
            {branch?.loading && !branch.items.length ? <p role="status">正在读取…</p> : branch?.error ? <p role="alert">{branch.error}</p> : !branch?.items.length ? <p>{hasFilters ? "没有符合筛选条件的知识。" : "这个文件夹是空的。"}</p> : branch.items.map((document) => <DocumentDirectoryRow
              key={document.id}
              document={document}
              folders={folders}
              selected={selectedId === document.id}
              onOpen={onOpen}
              onMove={onMove}
              checkbox={onSelect ? <label className="row-select"><span className="sr-only">选择 {document.title || "未命名网页"}</span><input type="checkbox" disabled={selectionDisabled || branch.loading || branch.context !== filterKey} checked={selectedIds?.has(document.id) ?? false} onChange={(event) => onSelect(document, event.target.checked)} /></label> : undefined}
            />)}
            {branch && branch.total > branch.pageSize && <nav className="folder-pagination" aria-label={`${folder.name}分页`}><button type="button" disabled={branch.loading || branch.page <= 1} onClick={() => void loadBranch(key, branch.page - 1)}>上一页</button><span>{branch.page} / {Math.ceil(branch.total / branch.pageSize)}</span><button type="button" disabled={branch.loading || branch.page * branch.pageSize >= branch.total} onClick={() => void loadBranch(key, branch.page + 1)}>下一页</button></nav>}
          </div>}
        </section>;
      })}
    </div>
    <span className="sr-only" aria-live="polite">已展开 {expanded.length} 个文件夹</span>
  </section>;
}
