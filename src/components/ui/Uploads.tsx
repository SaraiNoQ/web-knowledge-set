import { useRef, type ChangeEvent, type HTMLAttributes, type ReactNode } from "react";
import { Button } from "./Controls";
import { WorkspaceIcon } from "./WorkspaceIcon";

export function FileSelectButton({ label, inputLabel = label, accept, disabled, onChange }: {
  label: string; inputLabel?: string; accept: string; disabled?: boolean;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return <><input ref={input} className="sr-only" tabIndex={-1} aria-hidden="true" type="file" accept={accept} aria-label={inputLabel} disabled={disabled} onChange={onChange} /><Button disabled={disabled} onClick={() => input.current?.click()}>{label}</Button></>;
}

export function UploadZone({ title, hint, actions, icon = "import", children, className = "", ...props }: HTMLAttributes<HTMLDivElement> & {
  title: string; hint: string; actions: ReactNode; icon?: "import" | "paper";
}) {
  return <div className={`ui-upload-zone ${className}`} role="group" {...props}>
    <WorkspaceIcon name={icon} size={32} /><strong>{title}</strong>
    <div className="ui-upload-actions">{actions}</div><small>{hint}</small>{children}
  </div>;
}

export function FilePicker({ title, label = "选择文件", hint, accept, file, disabled, onFile, icon }: {
  title: string; label?: string; hint: string; accept: string; file?: File | null;
  disabled?: boolean; onFile: (file: File | null) => void; icon?: "import" | "paper";
}) {
  return <UploadZone title={title} hint={hint} icon={icon} aria-label={title} onDragOver={(event) => { event.preventDefault(); }} onDrop={(event) => { event.preventDefault(); if (!disabled) onFile(event.dataTransfer.files[0] || null); }} actions={<FileSelectButton label={label} accept={accept} disabled={disabled} onChange={(event) => { onFile(event.currentTarget.files?.[0] || null); event.currentTarget.value = ""; }} />}>
    {file && <div className="ui-upload-file"><WorkspaceIcon name={icon === "paper" ? "paper" : "document"} size={16} /><strong>{file.name}</strong><span>{(file.size / 1024).toFixed(1)} KB</span></div>}
  </UploadZone>;
}
