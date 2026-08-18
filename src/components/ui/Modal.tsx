import { useEffect, useId, useRef } from "react";

import type { MouseEvent, ReactNode } from "react";

import { IconButton } from "./Controls";

export interface ModalProps {
  children: ReactNode;
  className?: string;
  description?: ReactNode;
  dismissible?: boolean;
  footer?: ReactNode;
  open: boolean;
  onClose: () => void;
  panel?: boolean;
  role?: "dialog" | "alertdialog";
  title: ReactNode;
}

export function Modal({
  children,
  className = "",
  description,
  dismissible = true,
  footer,
  open,
  onClose,
  panel = true,
  role,
  title,
}: ModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !open) return;

    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();

    return () => {
      if (dialog.open) dialog.close();
      if (openerRef.current?.isConnected) openerRef.current.focus({ preventScroll: true });
    };
  }, [open]);

  const dismissFromBackdrop = (event: MouseEvent<HTMLDialogElement>) => {
    if (dismissible && event.target === event.currentTarget) onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      aria-describedby={description == null ? undefined : descriptionId}
      aria-labelledby={titleId}
      className={`ui-modal ${panel ? "" : className}`.trim()}
      role={role}
      onCancel={(event) => {
        event.preventDefault();
        if (dismissible) onClose();
      }}
      onMouseDown={dismissFromBackdrop}
    >
      {panel ? <section className={`ui-modal-panel ${className}`.trim()}>
        <header className="ui-modal-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description != null && <p id={descriptionId}>{description}</p>}
          </div>
          {dismissible && <IconButton label="关闭对话框" onClick={onClose}>×</IconButton>}
        </header>
        <div className="ui-modal-body">{children}</div>
        {footer != null && <footer className="ui-modal-footer">{footer}</footer>}
      </section> : <>
        <span id={titleId} className="sr-only">{title}</span>
        {description != null && <span id={descriptionId} className="sr-only">{description}</span>}
        {children}
      </>}
    </dialog>
  );
}
