import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "react";

import type { FormEvent, ReactNode } from "react";

import { Button, IconButton, Input } from "./Controls";
import { Modal } from "./Modal";

export type DialogTone = "default" | "warning" | "danger";

export interface DialogOptions {
  cancelLabel?: string;
  confirmLabel?: string;
  title?: ReactNode;
  tone?: DialogTone;
}

export interface PromptDialogOptions extends DialogOptions {
  initialValue?: string;
  label?: ReactNode;
  maxLength?: number;
  placeholder?: string;
  validate?: (value: string) => string | null | undefined;
}

export interface DialogsApi {
  alert: (message: ReactNode, options?: DialogOptions) => Promise<void>;
  confirm: (message: ReactNode, options?: DialogOptions) => Promise<boolean>;
  prompt: (message: ReactNode, options?: PromptDialogOptions) => Promise<string | null>;
}

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  action?: ToastAction;
}

export interface ToastApi {
  dismiss: (id: string) => void;
  error: (message: ReactNode, options?: ToastOptions) => string;
  success: (message: ReactNode, options?: ToastOptions) => string;
}

export interface UiProviderProps {
  children: ReactNode;
}

export type InlineNoticeTone = "info" | "success" | "warning" | "error";

export interface InlineNoticeProps {
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  title?: ReactNode;
  tone?: InlineNoticeTone;
}

type DialogKind = "alert" | "confirm" | "prompt";
type DialogResult = boolean | string | null | undefined;

interface DialogRequest {
  id: number;
  kind: DialogKind;
  message: ReactNode;
  options: PromptDialogOptions;
  resolve: (value: DialogResult) => void;
}

interface ToastRecord {
  action?: ToastAction;
  id: string;
  message: ReactNode;
  tone: "success" | "error";
}

const DialogsContext = createContext<DialogsApi | null>(null);
const ToastContext = createContext<ToastApi | null>(null);

export function useDialogs() {
  const value = useContext(DialogsContext);
  if (!value) throw new Error("useDialogs must be used inside UiProvider");
  return value;
}

export function useToast() {
  const value = useContext(ToastContext);
  if (!value) throw new Error("useToast must be used inside UiProvider");
  return value;
}

export function InlineNotice({
  action,
  children,
  className = "",
  title,
  tone = "info",
}: InlineNoticeProps) {
  const glyph = tone === "success" ? "✓" : tone === "warning" ? "!" : tone === "error" ? "×" : "i";
  return (
    <div className={`ui-inline-notice ui-inline-notice--${tone} ${className}`.trim()} role={tone === "error" ? "alert" : "status"}>
      <span className="ui-inline-notice-glyph" aria-hidden="true">{glyph}</span>
      <div>
        {title != null && <strong>{title}</strong>}
        <div>{children}</div>
      </div>
      {action != null && <div className="ui-inline-notice-action">{action}</div>}
    </div>
  );
}

function DialogHost({ request, finish }: { request: DialogRequest; finish: (value: DialogResult) => void }) {
  const [value, setValue] = useState(request.options.initialValue ?? "");
  const [validationError, setValidationError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const formId = useId();
  const errorId = useId();
  const title = request.options.title ?? (request.kind === "alert" ? "提示" : request.kind === "prompt" ? "输入内容" : "请确认");
  const confirmLabel = request.options.confirmLabel ?? (request.kind === "alert" ? "知道了" : "确认");
  const confirmVariant = request.options.tone === "danger" ? "danger" : request.options.tone === "warning" ? "warning" : "primary";
  const cancel = () => finish(request.kind === "confirm" ? false : request.kind === "prompt" ? null : undefined);
  const submitPrompt = (event: FormEvent) => {
    event.preventDefault();
    const error = request.options.validate?.(value);
    if (error) {
      setValidationError(error);
      return;
    }
    finish(value);
  };

  useEffect(() => {
    if (request.kind !== "prompt") return;
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [request.id, request.kind]);

  const footer = request.kind === "alert" ? (
    <Button autoFocus variant={confirmVariant} onClick={() => finish(undefined)}>{confirmLabel}</Button>
  ) : (
    <>
      <Button autoFocus={request.kind === "confirm"} onClick={cancel}>{request.options.cancelLabel ?? "取消"}</Button>
      <Button form={request.kind === "prompt" ? formId : undefined} type={request.kind === "prompt" ? "submit" : "button"} variant={confirmVariant} onClick={request.kind === "confirm" ? () => finish(true) : undefined}>{confirmLabel}</Button>
    </>
  );

  return (
    <Modal open title={title} description={request.message} dismissible={request.kind !== "alert"} footer={footer} onClose={cancel} role={request.kind === "prompt" ? "dialog" : "alertdialog"}>
      {request.kind === "prompt" && (
        <form id={formId} className="ui-prompt-form" onSubmit={submitPrompt}>
          <label htmlFor={`${formId}-input`}>{request.options.label ?? "输入内容"}</label>
          <Input
            ref={inputRef}
            id={`${formId}-input`}
            autoFocus
            aria-describedby={validationError ? errorId : undefined}
            invalid={Boolean(validationError)}
            maxLength={request.options.maxLength}
            placeholder={request.options.placeholder}
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              if (validationError) setValidationError("");
            }}
          />
          {validationError && <small id={errorId} role="alert">{validationError}</small>}
        </form>
      )}
    </Modal>
  );
}

function ToastItem({ toast, dismiss }: { toast: ToastRecord; dismiss: (id: string) => void }) {
  useEffect(() => {
    if (toast.tone === "error") return;
    const timer = window.setTimeout(() => dismiss(toast.id), 4_000);
    return () => window.clearTimeout(timer);
  }, [dismiss, toast.id, toast.tone]);

  return (
    <div className={`ui-toast ui-toast--${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"}>
      <span className="ui-toast-mark" aria-hidden="true">{toast.tone === "success" ? "✓" : "!"}</span>
      <div className="ui-toast-message">{toast.message}</div>
      {toast.action && <button type="button" className="ui-toast-action" onClick={() => { toast.action?.onClick(); dismiss(toast.id); }}>{toast.action.label}</button>}
      <IconButton label="关闭通知" onClick={() => dismiss(toast.id)}>×</IconButton>
    </div>
  );
}

export function UiProvider({ children }: UiProviderProps) {
  const dialogId = useRef(0);
  const toastId = useRef(0);
  const activeDialog = useRef<DialogRequest | null>(null);
  const dialogQueue = useRef<DialogRequest[]>([]);
  const [dialog, setDialog] = useState<DialogRequest | null>(null);
  const [toasts, setToasts] = useState<ToastRecord[]>([]);

  const enqueue = useCallback((kind: DialogKind, message: ReactNode, options: PromptDialogOptions = {}) => (
    new Promise<DialogResult>((resolve) => {
      const request = { id: ++dialogId.current, kind, message, options, resolve };
      if (activeDialog.current) dialogQueue.current.push(request);
      else {
        activeDialog.current = request;
        setDialog(request);
      }
    })
  ), []);

  const dialogs = useMemo<DialogsApi>(() => ({
    alert: async (message, options) => { await enqueue("alert", message, options); },
    confirm: async (message, options) => (await enqueue("confirm", message, options)) === true,
    prompt: async (message, options) => {
      const result = await enqueue("prompt", message, options);
      return typeof result === "string" ? result : null;
    },
  }), [enqueue]);

  const finishDialog = useCallback((requestId: number, value: DialogResult) => {
    const current = activeDialog.current;
    if (!current || current.id !== requestId) return;
    activeDialog.current = dialogQueue.current.shift() ?? null;
    current.resolve(value);
    setDialog(activeDialog.current);
  }, []);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const pushToast = useCallback((tone: ToastRecord["tone"], message: ReactNode, options: ToastOptions = {}) => {
    const id = `ui-toast-${++toastId.current}`;
    setToasts((current) => [...current.slice(-2), { id, message, tone, action: options.action }]);
    return id;
  }, []);

  const toastApi = useMemo<ToastApi>(() => ({
    dismiss,
    error: (message, options) => pushToast("error", message, options),
    success: (message, options) => pushToast("success", message, options),
  }), [dismiss, pushToast]);

  return (
    <DialogsContext.Provider value={dialogs}>
      <ToastContext.Provider value={toastApi}>
        {children}
        {dialog && <DialogHost key={dialog.id} request={dialog} finish={(value) => finishDialog(dialog.id, value)} />}
        <div className="ui-toast-region" role="region" aria-label="通知">
          {toasts.map((toast) => <ToastItem key={toast.id} toast={toast} dismiss={dismiss} />)}
        </div>
      </ToastContext.Provider>
    </DialogsContext.Provider>
  );
}
