import { forwardRef } from "react";

import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
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

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  density?: UiDensity;
  wrapperClassName?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className = "", density = "regular", multiple, wrapperClassName = "", ...props },
  ref,
) {
  return (
    <span
      className={`ui-select-wrap ui-select-wrap--${density} ${multiple ? "ui-select-wrap--multiple" : ""} ${wrapperClassName}`.trim()}
    >
      <select ref={ref} className={`ui-select ${className}`.trim()} multiple={multiple} {...props} />
    </span>
  );
});
