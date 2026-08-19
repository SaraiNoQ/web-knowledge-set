import { cloneElement, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { FocusEvent, KeyboardEvent, ReactElement, ReactNode } from "react";

export type FloatingPlacement = "top" | "bottom";

interface FloatingProps {
  children: ReactElement;
  content: ReactNode;
  delay?: number;
  disabled?: boolean;
  interactive: boolean;
  hoverOnly?: boolean;
  label?: string;
  placement?: FloatingPlacement;
}

export interface TooltipProps extends Omit<FloatingProps, "interactive" | "label"> {}

export interface HoverCardProps extends Omit<FloatingProps, "interactive"> {
  label?: string;
}

type TriggerAria = {
  "aria-controls"?: string;
  "aria-describedby"?: string;
  "aria-expanded"?: boolean;
  "aria-haspopup"?: "dialog";
};

function Floating({
  children,
  content,
  delay = 1_000,
  disabled = false,
  interactive,
  hoverOnly = false,
  label,
  placement: preferredPlacement = "top",
}: FloatingProps) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const openTimer = useRef<number | undefined>(undefined);
  const closeTimer = useRef<number | undefined>(undefined);
  const focusWithin = useRef(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: -10_000, top: -10_000, placement: preferredPlacement });
  const layerId = useId();

  const clearTimers = useCallback(() => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
  }, []);

  const openSoon = (immediate = false) => {
    window.clearTimeout(closeTimer.current);
    window.clearTimeout(openTimer.current);
    if (disabled || open) return;
    openTimer.current = window.setTimeout(() => setOpen(true), immediate ? 0 : Math.max(0, delay));
  };

  const closeSoon = () => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
    if (interactive && focusWithin.current) return;
    if (!interactive) {
      setOpen(false);
      return;
    }
    closeTimer.current = window.setTimeout(() => setOpen(false), 120);
  };

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    const layer = layerRef.current;
    if (!anchor || !layer) return;

    const margin = 8;
    const gap = 9;
    const anchorBox = anchor.getBoundingClientRect();
    const layerBox = layer.getBoundingClientRect();
    const roomAbove = anchorBox.top - gap;
    const roomBelow = window.innerHeight - anchorBox.bottom - gap;
    let placement = preferredPlacement;
    if (placement === "top" && layerBox.height > roomAbove && roomBelow > roomAbove) placement = "bottom";
    if (placement === "bottom" && layerBox.height > roomBelow && roomAbove > roomBelow) placement = "top";

    const naturalTop = placement === "top" ? anchorBox.top - layerBox.height - gap : anchorBox.bottom + gap;
    const left = Math.min(
      Math.max(margin, anchorBox.left + anchorBox.width / 2 - layerBox.width / 2),
      Math.max(margin, window.innerWidth - layerBox.width - margin),
    );
    const top = Math.min(Math.max(margin, naturalTop), Math.max(margin, window.innerHeight - layerBox.height - margin));
    setPosition({ left, top, placement });
  }, [preferredPlacement]);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    const frame = window.requestAnimationFrame(updatePosition);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [content, open, updatePosition]);

  useEffect(() => {
    if (!disabled) return;
    clearTimers();
    setOpen(false);
  }, [clearTimers, disabled]);

  useEffect(() => clearTimers, [clearTimers]);

  const keepOpenAcrossFocus = (event: FocusEvent) => {
    const next = event.relatedTarget;
    if (next instanceof Node && (anchorRef.current?.contains(next) || layerRef.current?.contains(next))) return;
    focusWithin.current = false;
    closeSoon();
  };

  const onEscape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !open) return;
    event.stopPropagation();
    focusWithin.current = false;
    setOpen(false);
  };

  let trigger = children;
  if (isValidElement<TriggerAria>(children)) {
    const aria = interactive && !hoverOnly
      ? { "aria-controls": open ? layerId : undefined, "aria-expanded": open, "aria-haspopup": "dialog" as const }
      : { "aria-describedby": open ? [children.props["aria-describedby"], layerId].filter(Boolean).join(" ") : children.props["aria-describedby"] };
    trigger = cloneElement(children, aria);
  }

  return (
    <>
      <span
        ref={anchorRef}
        className="ui-floating-anchor"
        onBlurCapture={keepOpenAcrossFocus}
        onClickCapture={hoverOnly ? () => { clearTimers(); focusWithin.current = false; setOpen(false); } : undefined}
        onFocusCapture={hoverOnly ? undefined : () => { focusWithin.current = true; openSoon(true); }}
        onKeyDownCapture={onEscape}
        onMouseEnter={() => openSoon()}
        onMouseLeave={closeSoon}
      >
        {trigger}
      </span>
      {open && createPortal(
        <div
          ref={layerRef}
          id={layerId}
          aria-label={interactive && !hoverOnly ? label ?? "更多信息" : undefined}
          className={interactive ? "ui-hover-card" : "ui-tooltip"}
          data-placement={position.placement}
          role={interactive && !hoverOnly ? "dialog" : "tooltip"}
          style={{ left: position.left, top: position.top }}
          onBlurCapture={interactive ? keepOpenAcrossFocus : undefined}
          onFocusCapture={interactive ? () => { focusWithin.current = true; openSoon(true); } : undefined}
          onKeyDownCapture={onEscape}
          onMouseEnter={interactive ? () => window.clearTimeout(closeTimer.current) : undefined}
          onMouseLeave={interactive ? closeSoon : undefined}
        >
          {content}
        </div>,
        document.body,
      )}
    </>
  );
}

export function Tooltip(props: TooltipProps) {
  return <Floating {...props} interactive={false} />;
}

export function HoverCard(props: HoverCardProps) {
  return <Floating {...props} interactive />;
}
