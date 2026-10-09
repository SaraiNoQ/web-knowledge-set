import { useEffect, useRef, useState } from "react";
import { Button, IconButton } from "./ui/Controls";
import { UploadZone } from "./ui/Uploads";
import { WorkspaceIcon } from "./ui/WorkspaceIcon";

function fileKey(file: File) { return file.webkitRelativePath || file.name; }
function size(bytes: number) { return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`; }

export function MarkdownUpload({ files, onChange, disabled, onPreparingChange }: { files: File[]; onChange: (files: File[]) => void; disabled: boolean; onPreparingChange: (busy: boolean) => void }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const directoryInput = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => () => { generation.current += 1; onPreparingChange(false); }, [onPreparingChange]);
  const addFiles = (selected: File[]) => {
    const accepted = selected.filter((file) => /\.(md|markdown)$/iu.test(file.name));
    if (!accepted.length) { setError("请选择 .md 或 .markdown 文件。"); return; }
    const merged = new Map(files.map((file) => [fileKey(file), file]));
    for (const file of accepted) merged.set(fileKey(file), file);
    onChange([...merged.values()]); setError("");
  };
  const drop = async (items: DataTransferItemList, fallback: File[]) => {
    if (disabled || preparing) return;
    const entries = Array.from(items).filter((item) => item.kind === "file").map((item) => item.webkitGetAsEntry?.()).filter(Boolean) as FileSystemEntry[];
    if (!entries.length) { addFiles(fallback); return; }
    const ticket = ++generation.current;
    setPreparing(true); onPreparingChange(true); setError("");
    const selected: File[] = [];
    let visited = 0;
    const walk = async (entry: FileSystemEntry) => {
      if (generation.current !== ticket) return;
      if (++visited > 5000) throw new Error("目录条目过多，请选择更小的目录。");
      if (entry.isFile && /\.(md|markdown)$/iu.test(entry.name)) {
        const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
        Object.defineProperty(file, "webkitRelativePath", { value: entry.fullPath.replace(/^\//u, "") });
        selected.push(file);
        if (selected.length > 100) throw new Error("一次最多添加 100 个 Markdown 文件。");
      } else if (entry.isDirectory) {
        const reader = (entry as FileSystemDirectoryEntry).createReader();
        while (generation.current === ticket) {
          const children = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
          if (!children.length) break;
          for (const child of children) await walk(child);
        }
      }
    };
    try { for (const entry of entries) await walk(entry); if (generation.current === ticket) addFiles(selected); }
    catch (cause) { if (generation.current === ticket) setError(cause instanceof Error ? cause.message : "无法读取目录，请使用“选择文件夹”。"); }
    finally { if (generation.current === ticket) { setPreparing(false); onPreparingChange(false); } }
  };
  return <div className="markdown-upload">
    <UploadZone className={`markdown-dropzone${dragging ? " is-dragging" : ""}`} aria-label="Markdown 上传区" title={preparing ? "正在读取目录…" : "拖放 Markdown 文件或目录"} hint="支持 .md、.markdown · 最多 100 个文件 · 总计 10 MiB" actions={<><Button disabled={disabled || preparing} onClick={() => fileInput.current?.click()}>选择文件</Button><Button disabled={disabled || preparing} onClick={() => directoryInput.current?.click()}>选择文件夹</Button></>}
      onDragOver={(event) => { event.preventDefault(); if (!disabled && !preparing) { setDragging(true); event.dataTransfer.dropEffect = "copy"; } }}
      onDragLeave={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false); }}
      onDrop={(event) => { event.preventDefault(); setDragging(false); void drop(event.dataTransfer.items, Array.from(event.dataTransfer.files)); }}>
      <input ref={fileInput} className="sr-only" tabIndex={-1} aria-label="选择 Markdown 文件" type="file" multiple accept=".md,.markdown,text/markdown,text/plain" disabled={disabled || preparing} onChange={(event) => { addFiles(Array.from(event.currentTarget.files || [])); event.currentTarget.value = ""; }} />
      <input ref={directoryInput} className="sr-only" tabIndex={-1} aria-label="选择 Markdown 目录" type="file" multiple {...{ webkitdirectory: "", directory: "" }} disabled={disabled || preparing} onChange={(event) => { addFiles(Array.from(event.currentTarget.files || [])); event.currentTarget.value = ""; }} />
    </UploadZone>
    {files.length > 0 && <><div className="upload-list-heading"><strong>已添加 {files.length} 个文件</strong><span>{size(files.reduce((sum, file) => sum + file.size, 0))}</span></div><ul className="upload-file-list" aria-label="已添加的 Markdown 文件">{files.map((file) => <li key={fileKey(file)}><WorkspaceIcon name="document" size={18} /><div><strong>{file.name}</strong><small>{fileKey(file)}</small></div><span>{size(file.size)}</span><IconButton label={`移除文件：${fileKey(file)}`} disabled={disabled || preparing} onClick={() => onChange(files.filter((value) => value !== file))}><WorkspaceIcon name="close" size={16} /></IconButton></li>)}</ul></>}
    {error && <p className="bulk-import-error" role="alert">{error}</p>}
  </div>;
}
