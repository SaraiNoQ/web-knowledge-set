import { Children, forwardRef, isValidElement, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  KeyboardEvent,
  OptionHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";

export type UiDensity = "compact" | "regular";
export type ButtonVariant = "primary" | "secondary" | "ghost" | "warning" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  density?: UiDensity;
  variant?: ButtonVariant;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className = "", density = "regular", type = "button", variant = "secondary", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={`ui-button ui-button--${variant} ui-button--${density} ${className}`.trim()}
      {...props}
    />
  );
});

export interface IconButtonProps extends Omit<ButtonProps, "aria-label"> {
  label: string;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { className = "", density = "compact", label, variant = "ghost", ...props },
  ref,
) {
  return (
    <Button
      ref={ref}
      aria-label={label}
      className={`ui-icon-button ${className}`.trim()}
      density={density}
      title={props.title ?? label}
      variant={variant}
      {...props}
    />
  );
});

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { "aria-invalid": ariaInvalid, className = "", invalid, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      aria-invalid={invalid || ariaInvalid || undefined}
      className={`ui-input ${className}`.trim()}
      {...props}
    />
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { "aria-invalid": ariaInvalid, className = "", invalid, ...props },
  ref,
) {
  return (
    <textarea
      ref={ref}
      aria-invalid={invalid || ariaInvalid || undefined}
      className={`ui-textarea ${className}`.trim()}
      {...props}
    />
  );
});

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  description?: ReactNode;
  label?: ReactNode;
  wrapperClassName?: string;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { className = "", description, label, wrapperClassName = "", ...props },
  ref,
) {
  const checkbox = <input ref={ref} type="checkbox" className={`ui-checkbox ${className}`.trim()} {...props} />;
  if (label == null && description == null) return checkbox;

  return (
    <label className={`ui-checkbox-field ${wrapperClassName}`.trim()}>
      {checkbox}
      <span>
        {label != null && <span className="ui-checkbox-label">{label}</span>}
        {description != null && <small>{description}</small>}
      </span>
    </label>
  );
});

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "onBlur" | "onClick" | "onFocus" | "onKeyDown"> {
  density?: UiDensity;
  wrapperClassName?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { "aria-label": ariaLabel, "aria-labelledby": ariaLabelledBy, autoFocus, children, className = "", density = "regular", disabled, multiple, value, defaultValue, wrapperClassName = "", ...props },
  ref,
) {
  const nativeRef = useRef<HTMLSelectElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [uncontrolledValue, setUncontrolledValue] = useState(() => String(defaultValue ?? ""));
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState({ left: -10_000, top: -10_000, width: 0 });
  const options = Children.toArray(children).flatMap((child) => {
    if (!isValidElement<OptionHTMLAttributes<HTMLOptionElement>>(child) || child.type !== "option") return [];
    return [{
      disabled: Boolean(child.props.disabled),
      label: child.props.label ?? Children.toArray(child.props.children).join(""),
      value: String(child.props.value ?? ""),
    }];
  });
  const selectedValue = String(value ?? uncontrolledValue);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === selectedValue));

  useImperativeHandle(ref, () => nativeRef.current!, []);
  useEffect(() => {
    if (!autoFocus) return;
    const frame = window.requestAnimationFrame(() => buttonRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [autoFocus]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!buttonRef.current?.contains(target) && !listRef.current?.contains(target)) setOpen(false);
    };
    const closeMenu = () => setOpen(false);
    const closeOnScroll = (event: Event) => { if (!(event.target instanceof Node) || !listRef.current?.contains(event.target)) closeMenu(); };
    const fieldset = buttonRef.current?.closest("fieldset");
    const disabledObserver = fieldset ? new MutationObserver(() => { if (buttonRef.current?.matches(":disabled")) closeMenu(); }) : null;
    if (fieldset) disabledObserver?.observe(fieldset, { attributes: true, attributeFilter: ["disabled"] });
    document.addEventListener("pointerdown", close);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeOnScroll, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeOnScroll, true);
      disabledObserver?.disconnect();
    };
  }, [open]);
  useLayoutEffect(() => {
    if (!open || !buttonRef.current || !listRef.current) return;
    const gap = 5;
    const margin = 8;
    const trigger = buttonRef.current.getBoundingClientRect();
    const list = listRef.current.getBoundingClientRect();
    const width = Math.min(Math.max(trigger.width, list.width), window.innerWidth - margin * 2);
    const left = Math.min(Math.max(margin, trigger.left), window.innerWidth - width - margin);
    const below = trigger.bottom + gap;
    const top = below + list.height <= window.innerHeight - margin ? below : Math.max(margin, trigger.top - list.height - gap);
    setPosition({ left, top, width });
  }, [open]);

  if (multiple) {
    return <span className={`ui-select-wrap ui-select-wrap--${density} ui-select-wrap--multiple ${wrapperClassName}`.trim()}><select ref={ref} className={`ui-select ${className}`.trim()} multiple value={value} defaultValue={defaultValue} disabled={disabled} autoFocus={autoFocus} {...props}>{children}</select></span>;
  }

  const move = (direction: 1 | -1) => {
    let next = activeIndex;
    do next = (next + direction + options.length) % options.length;
    while (options[next]?.disabled && next !== activeIndex);
    setActiveIndex(next);
  };
  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled || buttonRef.current?.matches(":disabled")) { setOpen(false); return; }
    setUncontrolledValue(option.value);
    const select = nativeRef.current;
    if (select) {
      select.value = option.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    setOpen(false);
    buttonRef.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") { setOpen(false); buttonRef.current?.focus(); return; }
    if (!open && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); setActiveIndex(selectedIndex); setOpen(true); return; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) { setActiveIndex(selectedIndex); setOpen(true); }
      else move(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (open && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); choose(activeIndex); }
    if (open && event.key === "Home") { event.preventDefault(); setActiveIndex(options.findIndex((option) => !option.disabled)); }
    if (open && event.key === "End") { event.preventDefault(); setActiveIndex(options.map((option) => !option.disabled).lastIndexOf(true)); }
    if (event.key === "Tab") setOpen(false);
  };

  return (
    <span className={`ui-select-wrap ui-select-wrap--${density} ${wrapperClassName}`.trim()}>
      <button
        ref={buttonRef}
        type="button"
        role="combobox"
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${activeIndex}` : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        className={`ui-select ${className}`.trim()}
        disabled={disabled}
        onClick={() => { setActiveIndex(selectedIndex); setOpen((current) => !current); }}
        onKeyDown={onKeyDown}
      >
        <span>{options[selectedIndex]?.label}</span>
      </button>
      <select ref={nativeRef} className="ui-select-native" aria-hidden="true" tabIndex={-1} value={value} defaultValue={defaultValue} disabled={disabled} {...props}>{children}</select>
      {open && createPortal(
        <div ref={listRef} id={listId} role="listbox" aria-label={ariaLabel ?? (ariaLabelledBy ? undefined : "选项")} aria-labelledby={ariaLabelledBy} className="ui-select-menu" style={position}>
          {options.map((option, index) => <div key={`${option.value}-${index}`} id={`${listId}-${index}`} role="option" aria-disabled={option.disabled || undefined} aria-selected={option.value === selectedValue} className={index === activeIndex ? "is-active" : ""} onMouseEnter={() => { if (!option.disabled) setActiveIndex(index); }} onPointerDown={(event) => { event.preventDefault(); choose(index); }}><span aria-hidden="true">{option.value === selectedValue ? "✓" : ""}</span>{option.label}</div>)}
        </div>,
        buttonRef.current?.closest("dialog") ?? document.body,
      )}
    </span>
  );
});
