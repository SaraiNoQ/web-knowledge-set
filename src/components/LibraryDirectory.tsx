import { WorkspaceIcon } from "./ui/WorkspaceIcon";
import { useCallback, useEffect, useId, useRef, useState } from "react";
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
  queued: "等待收取", fetching: "正在读取", extracting: "正在整理", ready: "可以阅读", failed: "收取失败",
};

function host(url: string) {
  try { const value = new URL(url); return value.protocol === "zhiye:" ? (value.hostname === "paper" ? "本地论文" : "本地文章") : value.hostname.replace(/^www\./u, "") || "本地导入"; } catch { return "本地导入"; }
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
  onTrash,
  onRename,
  onPermanentDelete,
}: {
  document: DocumentSummary;
  folders: KnowledgeFolder[];
  selected?: boolean;
  checkbox?: ReactNode;
  onOpen: (id: string) => void;
  onMove: (document: MoveDocumentTarget, folderId: string | null) => Promise<void>;
  onTrash?: (document: DocumentSummary) => Promise<void>;
  onRename?: (document: DocumentSummary) => Promise<void>;
  onPermanentDelete?: (document: DocumentSummary) => Promise<void>;
}) {
  const [moveOpen, setMoveOpen] = useState(false);
  const [targetFolder, setTargetFolder] = useState(document.folderId ?? "");
  const [moving, setMoving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const actionId = useId();
  const actionButton = useRef<HTMLButtonElement>(null);
  const actionMenu = useRef<HTMLDivElement>(null);
  const externalUrl = document.finalUrl || document.sourceUrl;
  const hasExternalUrl = /^(?:https?):/u.test(externalUrl);
  const folderName = folders.find(({ id }) => id === document.folderId)?.name ?? "未分组";
  const draggable = !document.deletedAt && !matchMedia("(hover: none), (pointer: coarse)").matches;
  const target = { id: document.id, revision: document.revision, folderId: document.folderId };

  const closeActions = useCallback(() => actionMenu.current?.hidePopover(), []);
  useEffect(() => {
    return () => {
      window.removeEventListener("resize", closeActions);
      window.removeEventListener("scroll", closeActions, true);
    };
  }, [closeActions]);

  const positionActions = () => {
    const trigger = actionButton.current?.getBoundingClientRect();
    const menu = actionMenu.current;
    if (!trigger || !menu) return;
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - 198, trigger.right - 190))}px`;
    menu.style.top = `${window.innerHeight - trigger.bottom > 180 ? trigger.bottom + 5 : Math.max(8, trigger.top - 172)}px`;
    window.addEventListener("resize", closeActions);
  };

  const move = async () => {
    const folderId = targetFolder || null;
    if (folderId === document.folderId) { setMoveOpen(false); return; }
    setMoving(true);
    try { await onMove(target, folderId); setMoveOpen(false); }
    finally { setMoving(false); }
  };

  const detail = <div className="directory-hover-detail">
    <span>类型 · {document.kind === "paper" ? "论文" : "文章"}</span>
    <strong>{document.title || "未命名织片"}</strong>
    <span>{host(externalUrl)} · {externalUrl}</span>
    {document.author && <span>作者 · {document.author}</span>}
    <span>分组 · {folderName}</span>
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
    {checkbox}
    <span className="sr-only">{STATUS[document.status]}</span>
    <HoverCard content={detail} delay={1_000} disabled={matchMedia("(hover: none), (pointer: coarse)").matches} hoverOnly label="织片详情">
      <Button type="button" className="directory-title document-row" aria-description={document.kind === "paper" ? "论文" : "文章"} aria-current={selected ? "true" : undefined} onClick={() => onOpen(document.id)}><WorkspaceIcon name={document.kind === "paper" ? "paper" : "document"} size={16} /><span className="directory-document-label">{document.title || "未命名织片"}</span></Button>
    </HoverCard>

    {((!document.deletedAt && onTrash) || hasExternalUrl) && <><IconButton ref={actionButton} label={`更多操作：${document.title || "未命名织片"}`} aria-haspopup="dialog" aria-controls={actionId} popoverTarget={actionId} onClick={positionActions}><WorkspaceIcon name="more" size={16} /></IconButton><div ref={actionMenu} id={actionId} popover="auto" className="directory-action-menu" role="dialog" aria-label={`操作：${document.title || "未命名织片"}`} onToggle={(event) => { const open = event.currentTarget.matches(":popover-open"); if (open) { event.currentTarget.querySelector<HTMLElement>("a, button")?.focus({ preventScroll: true }); window.addEventListener("scroll", closeActions, true); } else { window.removeEventListener("resize", closeActions); window.removeEventListener("scroll", closeActions, true); if (event.currentTarget.contains(globalThis.document.activeElement)) actionButton.current?.focus(); } }}>{hasExternalUrl && <a href={externalUrl} target="_blank" rel="noreferrer noopener" aria-label={`查看来源：${document.title || "未命名织片"}`} onClick={closeActions}>查看来源</a>}{!document.deletedAt && onTrash && <>{onRename && <Button type="button" onClick={() => { actionMenu.current?.hidePopover(); void onRename(document); }}>改名</Button>}<Button type="button" onClick={() => { actionMenu.current?.hidePopover(); setTargetFolder(document.folderId ?? ""); setMoveOpen(true); }}>移动资料</Button><Button type="button" className="danger" onClick={() => { actionMenu.current?.hidePopover(); void onTrash(document); }}>删除资料</Button></>}</div></>}
    {document.deletedAt && onPermanentDelete && <IconButton className="directory-permanent-delete" label={`永久删除：${document.title || "未命名织片"}`} disabled={deleting} onClick={() => { setDeleting(true); void onPermanentDelete(document).finally(() => setDeleting(false)); }}><WorkspaceIcon name="close" size={14} /></IconButton>}
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
  return <Modal open title="移动资料" dismissible={!moving} onClose={onClose} footer={<>
    <Button onClick={onClose} disabled={moving}>取消</Button><Button variant="primary" onClick={onMove} disabled={moving}>{moving ? "移动中…" : "移动"}</Button>
  </>}>
    <label className="directory-move-field"><span>移动到</span><Select autoFocus value={targetFolder} onChange={(event) => setTargetFolder(event.target.value)}><option value="">未分组</option>{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</Select></label>
  </Modal>;
}

interface Branch {
  context: string;
  error: string;
  items: DocumentSummary[];
  loading: boolean;
  total: number;
}

export function LibraryDirectory({
  total,
  folders,
  filters,
  refreshKey,
  onFoldersChanged,
  onOpen,
  onMove,
  onTrash,
  onRename,
  onCreateArticle,
  onCreatePaper,
  selectedId,
  selectedIds,
  selectionDisabled,
  listRef,
  onListKeyDown,
  onSelect,
  activeFolderId,
}: {
  total: number;
  folders: KnowledgeFolder[];
  filters: Omit<DocumentFilters, "folderId" | "unfiled" | "page" | "trash">;
  refreshKey: number;
  onFoldersChanged: () => void;
  onOpen: (id: string) => void;
  onMove: (document: MoveDocumentTarget, folderId: string | null) => Promise<void>;
  onTrash: (document: DocumentSummary) => Promise<void>;
  onRename: (document: DocumentSummary) => Promise<void>;
  onCreateArticle: () => Promise<void>;
  onCreatePaper: () => void;
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
  const createButton = useRef<HTMLButtonElement>(null);
  const createMenu = useRef<HTMLDivElement>(null);
  const createMenuId = useId();
  const filterKey = JSON.stringify(filters);
  const hasFilters = Object.entries(filters).some(([key, value]) => key !== "sort" && key !== "scope" && value !== undefined && value !== "");
  const closeCreateMenu = useCallback(() => createMenu.current?.hidePopover(), []);

  useEffect(() => () => {
    window.removeEventListener("resize", closeCreateMenu);
    window.removeEventListener("scroll", closeCreateMenu, true);
  }, [closeCreateMenu]);

  const loadBranch = useCallback(async (key: string) => {
    controllers.current.get(key)?.abort();
    const controller = new AbortController();
    controllers.current.set(key, controller);
    setBranches((current) => ({ ...current, [key]: { ...(current[key] ?? { items: [], total: 0 }), context: filterKey, loading: true, error: "" } }));
    try {
      const items: DocumentSummary[] = [];
      let page = 1;
      let total = 0;
      // ponytail: reuse the bounded REST pages; switch to a snapshot cursor if concurrent library growth makes offset scans insufficient.
      do {
        const result = await api.listDocuments({ ...filters, page, ...(key === "unfiled" ? { unfiled: true } : { folderId: key }) }, controller.signal);
        items.push(...result.items);
        total = result.total;
        if (!result.items.length || page * result.pageSize >= total) break;
        page += 1;
      } while (!controller.signal.aborted);
      if (!controller.signal.aborted) setBranches((current) => ({ ...current, [key]: { items: [...new Map(items.map((item) => [item.id, item])).values()], total, context: filterKey, loading: false, error: "" } }));
    } catch (error) {
      if (!controller.signal.aborted) setBranches((current) => ({ ...current, [key]: { ...(current[key] ?? { items: [], total: 0 }), context: filterKey, loading: false, error: (error as Error).message } }));
    } finally {
      if (controllers.current.get(key) === controller) controllers.current.delete(key);
    }
  }, [filterKey]);

  useEffect(() => {
    void loadBranch("unfiled");
    for (const key of expanded) void loadBranch(key);
    return () => { for (const controller of controllers.current.values()) controller.abort(); };
  }, [filterKey, refreshKey]);

  const pollingKey = ["unfiled", ...expanded].filter((key) => branches[key]?.items.some((item) => ["queued", "fetching", "extracting"].includes(item.status))).join("\0");
  useEffect(() => {
    if (!pollingKey) return;
    const timer = window.setInterval(() => {
      for (const key of pollingKey.split("\0")) if (!controllers.current.has(key)) void loadBranch(key);
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
      toast.success("已自动收起最早打开的分组，最多同时展开 6 个。");
    }
    setExpanded(next);
    void loadBranch(key);
  };

  useEffect(() => {
    if (!selectedId || activeFolderId === undefined) return;
    if (activeFolderId === null) return;
    const key = activeFolderId;
    if (!expanded.includes(key)) toggle(key);
  }, [activeFolderId, selectedId]);

  const createFolder = async () => {
    const name = (await dialogs.prompt("创建一个新的一级分组。", { title: "新建分组", label: "分组名称", confirmLabel: "创建", maxLength: 100 }))?.trim();
    if (!name) return;
    try { await api.createFolder(name); toast.success(`已创建分组“${name}”。`); onFoldersChanged(); }
    catch (error) { toast.error((error as Error).message); }
  };

  const positionCreateMenu = () => {
    const trigger = createButton.current?.getBoundingClientRect();
    const menu = createMenu.current;
    if (!trigger || !menu) return;
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - menu.offsetWidth - 8, trigger.right - menu.offsetWidth))}px`;
    menu.style.top = `${window.innerHeight - trigger.bottom >= menu.offsetHeight + 5 ? trigger.bottom + 5 : Math.max(8, trigger.top - menu.offsetHeight - 5)}px`;
  };

  const prepareCreateMenu = () => {
    window.addEventListener("resize", closeCreateMenu);
  };

  const renameFolder = async (folder: KnowledgeFolder) => {
    const name = (await dialogs.prompt(`改名“${folder.name}”。`, { title: "修改名称", label: "分组名称", initialValue: folder.name, confirmLabel: "保存", maxLength: 100 }))?.trim();
    if (!name || name === folder.name) return;
    try { await api.updateFolder(folder.id, name); toast.success(`已更名为“${name}”。`); onFoldersChanged(); }
    catch (error) { toast.error((error as Error).message); }
  };

  const deleteFolder = async (folder: KnowledgeFolder) => {
    if (!await dialogs.confirm(`删除“${folder.name}”？其中 ${folder.documentCount} 张织片会保留并移到“未分组”。`, { title: "删除分组", confirmLabel: "删除分组", tone: "danger" })) return;
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
    <header className="panel-heading"><div className="library-title-group"><h2 id="folder-directory-title">资料目录</h2><span className="total-count">{total}<small>篇</small></span></div><IconButton ref={createButton} label="新建" aria-haspopup="dialog" aria-controls={createMenuId} popoverTarget={createMenuId} onClick={prepareCreateMenu}><WorkspaceIcon name="plus" size={18} /></IconButton><div ref={createMenu} id={createMenuId} popover="auto" className="directory-action-menu" role="dialog" aria-label="新建" onToggle={(event) => { const open = event.currentTarget.matches(":popover-open"); if (open) { positionCreateMenu(); event.currentTarget.querySelector<HTMLElement>("a, button")?.focus({ preventScroll: true }); window.addEventListener("scroll", closeCreateMenu, true); } else { window.removeEventListener("resize", closeCreateMenu); window.removeEventListener("scroll", closeCreateMenu, true); if (event.currentTarget.contains(globalThis.document.activeElement)) createButton.current?.focus(); } }}><Button type="button" onClick={() => { createMenu.current?.hidePopover(); void createFolder(); }}>新建分组</Button><Button type="button" onClick={() => { createMenu.current?.hidePopover(); void onCreateArticle(); }}>新建文章</Button><Button type="button" onClick={() => { createMenu.current?.hidePopover(); onCreatePaper(); }}>导入论文</Button></div></header>
    <div ref={listRef} className="folder-tree" onKeyDown={onListKeyDown}>
      <div className="root-contents" role="region" aria-label="未分组内容" onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }} onDrop={(event) => void drop(event, null)}>
        {root?.loading && !root.items.length ? <p role="status">正在读取…</p> : root?.error ? <p role="alert">{root.error}</p> : !root?.items.length ? <p>{hasFilters ? "没有符合筛选条件的顶层知识。" : "所有织片都已分组。"}</p> : root.items.map((document) => <DocumentDirectoryRow
          key={document.id}
          document={document}
          folders={folders}
          selected={selectedId === document.id}
          onOpen={onOpen}
          onMove={onMove}
          onTrash={onTrash} onRename={onRename}
          checkbox={onSelect ? <label className="row-select"><span className="sr-only">选择 {document.title || "未命名织片"}</span><input type="checkbox" disabled={selectionDisabled || root.loading || root.context !== filterKey} checked={selectedIds?.has(document.id) ?? false} onChange={(event) => onSelect(document, event.target.checked)} /></label> : undefined}
        />)}
      </div>
      {folders.map((folder) => {
        const key = folder.id;
        const open = expanded.includes(key);
        const branch = branches[key];
        return <section key={key} className={`folder-branch ${open ? "is-open" : ""}`}>
          <div className="folder-node" onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }} onDrop={(event) => void drop(event, key)}>
            <Button type="button" aria-expanded={open} onClick={() => toggle(key)}><span className={open ? "folder-chevron is-open" : "folder-chevron"}><WorkspaceIcon name="chevron" size={12} /></span><WorkspaceIcon name="folder" size={18} /><strong>{folder.name}</strong><em>{branch?.total ?? (hasFilters ? "—" : folder.documentCount)}</em></Button>
            <div><IconButton label={`改名 ${folder.name}`} onClick={() => void renameFolder(folder)}><WorkspaceIcon name="edit" size={14} /></IconButton><IconButton label={`删除 ${folder.name}`} onClick={() => void deleteFolder(folder)}><WorkspaceIcon name="close" size={14} /></IconButton></div>
          </div>
          {open && <div className="folder-contents">
            {branch?.loading && !branch.items.length ? <p role="status">正在读取…</p> : branch?.error ? <p role="alert">{branch.error}</p> : !branch?.items.length ? <p>{hasFilters ? "没有符合筛选条件的知识。" : "这个分组里还没有织片。"}</p> : branch.items.map((document) => <DocumentDirectoryRow
              key={document.id}
              document={document}
              folders={folders}
              selected={selectedId === document.id}
              onOpen={onOpen}
              onMove={onMove}
              onTrash={onTrash} onRename={onRename}
              checkbox={onSelect ? <label className="row-select"><span className="sr-only">选择 {document.title || "未命名织片"}</span><input type="checkbox" disabled={selectionDisabled || branch.loading || branch.context !== filterKey} checked={selectedIds?.has(document.id) ?? false} onChange={(event) => onSelect(document, event.target.checked)} /></label> : undefined}
            />)}
          </div>}
        </section>;
      })}
    </div>
    <span className="sr-only" aria-live="polite">已展开 {expanded.length} 个分组</span>
  </section>;
}
