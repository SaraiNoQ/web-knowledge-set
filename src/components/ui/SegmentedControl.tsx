import { motion } from "motion/react";
import type { CSSProperties, ReactNode } from "react";
import { Button } from "./Controls";
import { MATERIAL_SPRING } from "./InteractionMotion";

export function SegmentedControl<T extends string>({ label, value, options, onChange, disabled = false, className = "" }: {
  label: string;
  value: T;
  options: readonly { value: T; label: string; icon?: ReactNode; disabled?: boolean }[];
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
}) {
  const selected = Math.max(0, options.findIndex((option) => option.value === value));
  return <fieldset className={`ui-segmented ${className}`} disabled={disabled} style={{ "--segment-count": options.length } as CSSProperties}>
    <legend className="sr-only">{label}</legend>
    <motion.span aria-hidden="true" className="ui-segmented-surface" initial={false} animate={{ x: `${selected * 100}%` }} transition={MATERIAL_SPRING} />
    {options.map((option, index) => <Button key={option.value} variant="ghost" density="compact" aria-pressed={value === option.value} aria-label={option.label} title={option.icon ? option.label : undefined} disabled={option.disabled} onClick={() => onChange(option.value)} onKeyDown={(event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const choices = options.map((candidate, item) => !candidate.disabled ? item : -1).filter((item) => item >= 0);
      if (!choices.length) return;
      const current = choices.indexOf(index);
      const next = event.key === "Home" ? choices[0] : event.key === "End" ? choices.at(-1)! : choices[(current + (event.key === "ArrowRight" ? 1 : choices.length - 1)) % choices.length];
      onChange(options[next].value);
      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
    }}>{option.icon || option.label}</Button>)}
  </fieldset>;
}
