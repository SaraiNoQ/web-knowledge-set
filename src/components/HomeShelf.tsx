import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject, type KeyboardEvent } from "react";
import { HOME_COLORS, HOME_MAX_IMAGE_BYTES, type HomeCard, type HomePage, type HomePresentation } from "../../shared/home";
import { api } from "../api";
import { ArticleCover } from "./ArticleCover";
import { Button, Checkbox, Input, Select } from "./ui/Controls";
import { FileSelectButton } from "./ui/Uploads";
import { useDialogs, useToast } from "./ui/Feedback";
import { WorkspaceIcon } from "./ui/WorkspaceIcon";
import "../home-bookshelf.css";

export interface HomeViewState { folder: string; page: number; scroll: number }
const colorLabels: Record<HomePresentation["color"], string> = { ochre: "麦黄", rust: "陶红", sage: "苔绿", sky: "雾蓝", paper: "原纸" };
const presentation = ({ documentId, featured, position, coverHash, color, shortTitle, fit }: HomeCard): HomePresentation => ({ documentId, featured, position, coverHash, color, shortTitle, fit });

async function imageForCover(file: File) {
  if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type) || file.size > 10 * 1024 * 1024) throw new Error("请选择不超过 10 MB 的 PNG、JPEG、WebP 或 GIF 图片。");
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new Error("这张图片无法读取，请换一张图片。"); }
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 16_000_000) throw new Error("图片像素过大，请选择不超过 1600 万像素的图片。");
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器暂时无法处理图片，请重试。");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("图片转换失败，请重试。")), "image/png"));
    if (blob.size > HOME_MAX_IMAGE_BYTES) throw new Error("转换后的封面超过 2 MB，请使用尺寸更小或内容更简单的图片。");
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",", 2)[1]!);
      reader.onerror = () => reject(new Error("图片读取失败，请重试。"));
      reader.readAsDataURL(blob);
    });
  } finally { bitmap.close(); }
}

function Pagination({ page, total, busy, onChange }: { page: number; total: number; busy: boolean; onChange: (page: number) => void }) {
  if (total <= 24) return null;
  return <nav className="home-pagination" aria-label="文章分页">
    <Button disabled={busy || page <= 1} onClick={() => onChange(page - 1)}>上一页</Button>
    <span>{page} / {Math.ceil(total / 24)}</span>
    <Button disabled={busy || page * 24 >= total} onClick={() => onChange(page + 1)}>下一页</Button>
  </nav>;
}

interface HomeShelfProps {
  onOpenDocument: (id: string) => Promise<unknown>;
  onImport: () => void;
  refreshKey: number;
  onDirtyChange: (dirty: boolean) => void;
  discardRevision: number;
  view: MutableRefObject<HomeViewState>;
}

export function HomeShelf({ onOpenDocument, onImport, refreshKey, onDirtyChange, discardRevision, view }: HomeShelfProps) {
  const [editing, setEditing] = useState(false);
  const [folder, setFolder] = useState(view.current.folder);
  const [page, setPage] = useState(view.current.page);
  const [data, setData] = useState<HomePage | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const root = useRef<HTMLElement>(null);
  const scroller = () => root.current?.closest<HTMLElement>(".reader-main");
  useEffect(() => {
    if (editing) return;
    const controller = new AbortController();
    setBusy(true); setError("");
    void api.home({ folder, page }, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      if (folder && !value.folders.some(item => item.id === folder)) { setFolder(""); setPage(1); view.current = { folder: "", page: 1, scroll: 0 }; return; }
      if (page > 1 && !value.items.length) { setPage(1); return; }
      setData(value);
    }).catch(cause => { if (!controller.signal.aborted) setError((cause as Error).message); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [folder, page, editing, refreshKey, reload, view]);
  useLayoutEffect(() => {
    if (!busy && !editing && data) scroller()?.scrollTo({ top: view.current.scroll });
  }, [busy, editing, data, view]);
  useEffect(() => {
    const element = scroller();
    if (!element || editing || busy || !data) return;
    const remember = () => { view.current = { folder, page, scroll: element.scrollTop }; };
    element.addEventListener("scroll", remember, { passive: true });
    return () => element.removeEventListener("scroll", remember);
  }, [folder, page, editing, busy, data, view]);
  const switchPage = (nextPage: number, nextFolder = folder) => {
    view.current = { folder: nextFolder, page: nextPage, scroll: 0 };
    setFolder(nextFolder); setPage(nextPage);
  };
  const tabKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]"));
    const active = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (active < 0) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (active + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus(); buttons[next]?.click();
  };
  return <section ref={root} className="home-workspace" aria-label={editing ? "首页布置" : "首页书架"}>
    {editing ? <HomeEditor onClose={() => { setEditing(false); setReload(value => value + 1); }} onDirtyChange={onDirtyChange} discardRevision={discardRevision} /> : <>
      <header className="home-heading"><div><h1>首页书架</h1><p>把值得重读的文章，留在眼前。</p></div><Button onClick={() => { setEditing(true); scroller()?.scrollTo({ top: 0 }); }}><WorkspaceIcon name="edit" size={16} />布置首页</Button></header>
      <div className="home-folder-tabs" role="tablist" aria-label="首页文件夹" onKeyDown={tabKeys}>
        {[{ id: "", name: "全部" }, ...(data?.folders ?? [])].map(item => <Button key={item.id} role="tab" aria-selected={folder === item.id} aria-controls="home-shelf-panel" tabIndex={folder === item.id ? 0 : -1} onClick={() => switchPage(1, item.id)}>{item.name}</Button>)}
      </div>
      <div id="home-shelf-panel" role="tabpanel" aria-label={data?.folders.find(item => item.id === folder)?.name || "全部首页文章"} aria-busy={busy}>
        {error ? <div className="home-empty" role="alert"><h2>书架暂时没有打开</h2><p>{error}</p><Button onClick={() => setReload(value => value + 1)}>重试</Button></div> : busy ? <div className="home-loading" role="status">正在整理书架…</div> : !data?.items.length ? <div className="home-empty"><WorkspaceIcon name="paper" size={40} /><h2>{data?.libraryTotal ? "挑几篇文章，放上书架" : "从第一篇文章开始"}</h2><p>{data?.libraryTotal ? "选好封面和顺序，下一次打开就能直接阅读。" : "先把文章保存到资料库，再布置你的首页。"}</p><Button variant="primary" onClick={data?.libraryTotal ? () => setEditing(true) : onImport}>{data?.libraryTotal ? "挑选首页文章" : "导入文章"}</Button></div> : <>
          <div className="home-book-grid">{data.items.map(article => <button key={article.documentId} className="home-book" onClick={() => void onOpenDocument(article.documentId)} aria-label={`阅读：${article.title}`}>
            <ArticleCover article={article} />
            <span className="home-book-meta"><span>{article.folderName || "未分组"}</span><time dateTime={article.createdAt}>{new Date(article.createdAt).toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" })}</time></span>
            <span className="home-book-name">{article.title}</span>
          </button>)}</div>
          <Pagination page={page} total={data.total} busy={busy} onChange={next => switchPage(next)} />
        </>}
      </div>
    </>}
  </section>;
}

function HomeEditor({ onClose, onDirtyChange, discardRevision }: { onClose: () => void; onDirtyChange: (dirty: boolean) => void; discardRevision: number }) {
  const dialogs = useDialogs(), toast = useToast();
  const [catalog, setCatalog] = useState<HomePage | null>(null);
  const [selected, setSelected] = useState<HomeCard[]>([]);
  const [changes, setChanges] = useState<Record<string, HomeCard>>({});
  const [active, setActive] = useState<HomeCard | null>(null);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [tab, setTab] = useState<"catalog" | "selected">("catalog");
  const [revision, setRevision] = useState<number | null>(null);
  const baselineRevision = useRef<number | null>(null);
  const [conflict, setConflict] = useState(false);
  const [selectedReady, setSelectedReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedLoading, setSelectedLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const token = useRef(0), dirty = Object.keys(changes).length > 0;
  const busy = saving || uploading || selectedLoading;
  const saveBusy = useRef(false);
  const previewRef = useRef<HTMLElement>(null);
  const catalogRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (active && (previewRef.current?.parentElement?.clientWidth ?? 0) < 640) previewRef.current?.scrollIntoView({ block: "start" });
  }, [active?.documentId]);
  useEffect(() => { onDirtyChange(dirty || saving || uploading); }, [dirty, saving, uploading, onDirtyChange]);
  useEffect(() => () => { token.current++; onDirtyChange(false); }, [onDirtyChange]);
  useEffect(() => {
    baselineRevision.current = null; setConflict(false); setSelectedReady(false);
    setChanges({}); setActive(null); setRevision(null); setUploading(false); setReload(value => value + 1); token.current++;
  }, [discardRevision]);
  const acceptRevision = (value: number) => {
    if (baselineRevision.current === null) { baselineRevision.current = value; setRevision(value); }
    else if (baselineRevision.current !== value) {
      setConflict(true);
      throw new Error("首页已在其他页面更新，请重新加载后再布置。");
    }
  };
  useEffect(() => {
    const timer = window.setTimeout(() => { setSearch(query.trim()); setPage(1); }, 250);
    return () => window.clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    void (async () => {
      const first = await api.home({ manage: true, q: search, page }, controller.signal);
      if (controller.signal.aborted) return;
      acceptRevision(first.revision);
      setCatalog(first);
    })().catch(cause => { if (!controller.signal.aborted) setError((cause as Error).message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [search, page, reload]);
  useEffect(() => {
    const controller = new AbortController();
    setSelectedLoading(true); setSelectedReady(false);
    void (async () => {
      const rows: HomeCard[] = [];
      let next = 1;
      do {
        const response = await api.home({ page: next }, controller.signal);
        if (controller.signal.aborted) return;
        acceptRevision(response.revision);
        rows.push(...response.items);
        if (next * 24 >= response.total || !response.items.length) break;
        next++;
      } while (!controller.signal.aborted);
      setSelected(rows); setSelectedReady(true);
    })().catch(cause => { if (!controller.signal.aborted) setError((cause as Error).message); })
      .finally(() => { if (!controller.signal.aborted) setSelectedLoading(false); });
    return () => controller.abort();
  }, [reload]);
  const effective = (card: HomeCard) => changes[card.documentId] ?? card;
  const selectedMap = new Map(selected.map(card => [card.documentId, effective(card)]));
  for (const card of Object.values(changes)) selectedMap.set(card.documentId, card);
  const selectedRows = [...selectedMap.values()].filter(card => card.featured).sort((a, b) => a.position - b.position || a.documentId.localeCompare(b.documentId));
  const editingCard = active ? effective(active) : null;
  const update = (card: HomeCard, patch: Partial<HomePresentation>) => setChanges(current => ({ ...current, [card.documentId]: { ...card, ...current[card.documentId], ...patch } }));
  const choose = (card: HomeCard, featured: boolean) => {
    update(card, { featured, ...(featured && !card.featured ? { position: Math.min(999999, Math.max(0, ...selectedRows.map(row => row.position)) + 1) } : {}) });
    setActive(card);
  };
  const move = (index: number, direction: number) => {
    const ordered = [...selectedRows];
    const other = index + direction;
    if (other < 0 || other >= ordered.length) return;
    [ordered[index], ordered[other]] = [ordered[other]!, ordered[index]!];
    setChanges(current => ({ ...current, ...Object.fromEntries(ordered.flatMap((card, position) => card.position === position ? [] : [[card.documentId, { ...card, position }]])) }));
  };
  const leave = async () => {
    if (busy) return;
    if (dirty && !await dialogs.confirm("首页布置尚未保存，确定放弃修改吗？", { title: "返回首页", confirmLabel: "放弃修改" })) return;
    onDirtyChange(false); onClose();
  };
  const save = async () => {
    if (!dirty || revision === null || conflict || !selectedReady || saveBusy.current || uploading) return;
    saveBusy.current = true; setSaving(true); setError("");
    try {
      await api.saveHome(revision, Object.values(changes).map(presentation));
      onDirtyChange(false); toast.success("首页布置已保存。"); onClose();
    } catch (cause) { setError((cause as Error).message); }
    finally { saveBusy.current = false; setSaving(false); }
  };
  const upload = async (file: File) => {
    if (!editingCard || busy) return;
    const card = editingCard, current = ++token.current;
    setUploading(true); setError("");
    try {
      const image = await imageForCover(file);
      if (current !== token.current) return;
      const result = await api.uploadHomeCover(image);
      if (current === token.current) update(card, { coverHash: result.hash });
    } catch (cause) { if (current === token.current) setError((cause as Error).message); }
    finally { if (current === token.current) setUploading(false); }
  };
  const reset = async () => {
    if (busy || dirty && !await dialogs.confirm("重新加载会放弃未保存的首页布置。", { title: "重新加载", confirmLabel: "放弃并加载" })) return;
    baselineRevision.current = null; setConflict(false); setSelectedReady(false);
    setChanges({}); setActive(null); setRevision(null); setReload(value => value + 1);
  };
  const rows = tab === "catalog" ? catalog?.items.map(effective) ?? [] : selectedRows;
  return <>
    <header className="home-heading home-editor-heading"><div><Button variant="ghost" className="home-back" disabled={busy} onClick={() => void leave()}><WorkspaceIcon name="chevron" size={14} />返回首页</Button><h1>布置首页</h1><p>挑选文章，为它们换上封面。</p></div><div className="home-editor-save"><span aria-live="polite">{dirty ? "有未保存修改" : "修改后保存生效"}</span><Button variant="primary" disabled={!dirty || busy || conflict || !selectedReady || revision === null} onClick={() => void save()}>{saving ? "正在保存…" : "保存布置"}</Button></div></header>
    {(error || conflict || !selectedReady && !selectedLoading) && <div className="home-error" role="alert"><span>{error || (conflict ? "首页已在其他页面更新，请重新加载后再布置。" : "已选文章尚未读取完整，请重新加载。")}</span><Button disabled={busy} onClick={() => void reset()}>重新加载</Button></div>}
    <div className="home-editor-grid">
      <section ref={catalogRef} className="home-catalog" aria-label="挑选首页文章">
        <div className="home-editor-tabs" role="group" aria-label="布置文章范围"><Button aria-pressed={tab === "catalog"} onClick={() => setTab("catalog")}>挑选文章</Button><Button aria-pressed={tab === "selected"} onClick={() => setTab("selected")}>已选文章 <span>{selectedRows.length}</span></Button></div>
        {tab === "catalog" && <label className="home-search"><WorkspaceIcon name="search" size={18} /><Input aria-label="搜索首页候选文章" placeholder="搜索文章标题" value={query} onChange={event => setQuery(event.target.value)} /></label>}
        {tab === "selected" && <p className="home-list-help">上移或下移，调整首页展示顺序。</p>}
        {(loading && tab === "catalog" || selectedLoading && tab === "selected") ? <p className="home-loading" role="status">正在读取文章…</p> : !rows.length ? <p className="home-list-empty">{tab === "selected" ? "还没有选入首页的文章。" : search ? "没有找到匹配的文章。" : "还没有可以展示的文章，请先导入。"}</p> : <ul className="home-article-list">{rows.map((card, index) => <li key={card.documentId} className={active?.documentId === card.documentId ? "is-active" : ""}>
          <Checkbox aria-label={`在首页展示：${card.title}`} checked={card.featured} disabled={busy} onChange={event => choose(card, event.target.checked)} />
          <button className="home-article-select" aria-pressed={active?.documentId === card.documentId} onClick={() => setActive(card)}><span className="home-mini-cover"><ArticleCover article={card} /></span><span><strong>{card.title}</strong><small>{card.folderName || "未分组"}</small></span></button>
          {tab === "selected" && <span className="home-order-actions"><Button density="compact" disabled={busy || index === 0} aria-label={`上移：${card.title}`} onClick={() => move(index, -1)}>上移</Button><Button density="compact" disabled={busy || index === rows.length - 1} aria-label={`下移：${card.title}`} onClick={() => move(index, 1)}>下移</Button></span>}
        </li>)}</ul>}
        {tab === "catalog" && <Pagination page={page} total={catalog?.total ?? 0} busy={loading || busy} onChange={setPage} />}
      </section>
      <section ref={previewRef} className="home-cover-editor" aria-label="文章封面设置">
        {editingCard ? <>
          <Button className="home-mobile-back" variant="ghost" onClick={() => catalogRef.current?.scrollIntoView({ block: "start" })}>继续挑选文章</Button>
          <div className="home-cover-preview"><ArticleCover article={editingCard} preview /></div>
          <h2>{editingCard.title}</h2>
          <Checkbox label="在首页展示" checked={editingCard.featured} disabled={busy} onChange={event => choose(editingCard, event.target.checked)} />
          <div className="home-cover-actions"><FileSelectButton label={uploading ? "正在上传…" : editingCard.coverHash ? "更换封面" : "上传封面"} inputLabel="上传文章封面" accept="image/png,image/jpeg,image/webp,image/gif" disabled={busy} onChange={event => { const file = event.currentTarget.files?.[0]; if (file) void upload(file); event.currentTarget.value = ""; }} />{editingCard.coverHash && <Button disabled={busy} onClick={() => update(editingCard, { coverHash: null })}>使用文字书封</Button>}</div>
          <p className="home-cover-hint">图片不超过 10 MB；无图时自动展示文字书封。</p>
          {editingCard.coverHash ? <label className="home-field">图片展示<Select aria-label="封面图片展示" value={editingCard.fit} disabled={busy} onChange={event => update(editingCard, { fit: event.target.value as HomePresentation["fit"] })}><option value="contain">完整显示</option><option value="cover">填满裁切</option></Select></label> : <>
            <label className="home-field">封面短标题<Input aria-label="封面短标题" value={editingCard.shortTitle} maxLength={100} placeholder="默认使用文章标题" disabled={busy} onChange={event => update(editingCard, { shortTitle: event.target.value })} /></label>
            <fieldset className="home-color-options"><legend>书封配色</legend>{HOME_COLORS.map(color => <button type="button" key={color} className={`home-color home-color--${color}`} aria-label={colorLabels[color]} aria-pressed={editingCard.color === color} disabled={busy} onClick={() => update(editingCard, { color })}><span />{colorLabels[color]}</button>)}</fieldset>
          </>}
        </> : <div className="home-editor-placeholder"><WorkspaceIcon name="paper" size={38} /><h2>为文章挑一张封面</h2><p>选择一篇文章，预览并调整它在首页的样子。</p></div>}
      </section>
    </div>
  </>;
}
