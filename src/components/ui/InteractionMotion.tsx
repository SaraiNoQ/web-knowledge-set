import { useEffect, type ReactNode } from "react";
import { animate } from "motion/mini";
import { spring, type AnimationPlaybackControls } from "motion";
import { MotionConfig, useReducedMotion } from "motion/react";

export const MATERIAL_SPRING = { type: "spring", stiffness: 480, damping: 36, mass: .7 } as const;

/** Shared physical feedback also covers plain buttons and portalled dialogs. */
export function InteractionMotion({ children }: { children: ReactNode }) {
  const reduced = useReducedMotion();
  useEffect(() => {
    if (reduced) return;
    const controls = new Map<HTMLButtonElement, { animation: AnimationPlaybackControls; transform: string; pressed: boolean }>();
    const release = () => {
      for (const [button, state] of controls) {
        if (!state.pressed) continue;
        state.animation.stop();
        state.pressed = false;
        state.animation = animate(button, { transform: state.transform || "translateY(0px) scale(1)" }, { ...MATERIAL_SPRING, type: spring, onComplete: () => {
          if (controls.get(button) !== state) return;
          state.animation.cancel();
          button.style.transform = state.transform;
          controls.delete(button);
        } });
      }
    };
    const press = (event: PointerEvent | KeyboardEvent) => {
      if (event instanceof PointerEvent && (event.button !== 0 || !event.isPrimary)) return;
      if (event instanceof KeyboardEvent && (event.repeat || !["Enter", " "].includes(event.key))) return;
      const button = event.target instanceof Element ? event.target.closest("button") : null;
      if (!(button instanceof HTMLButtonElement) || button.matches(":disabled") || controls.get(button)?.pressed) return;
      release();
      const previous = controls.get(button);
      previous?.animation.stop();
      const transform = previous?.transform ?? button.style.transform;
      controls.set(button, { transform, pressed: true, animation: animate(button, { transform: "translateY(1px) scale(.985)" }, { ...MATERIAL_SPRING, type: spring }) });
    };
    const releaseKey = (event: KeyboardEvent) => { if (["Enter", " ", "Escape"].includes(event.key)) release(); };
    document.addEventListener("pointerdown", press, true);
    document.addEventListener("keydown", press, true);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    window.addEventListener("keyup", releaseKey);
    window.addEventListener("blur", release);
    return () => {
      document.removeEventListener("pointerdown", press, true);
      document.removeEventListener("keydown", press, true);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("keyup", releaseKey);
      window.removeEventListener("blur", release);
      for (const [button, state] of controls) { state.animation.cancel(); button.style.transform = state.transform; }
    };
  }, [reduced]);
  return <MotionConfig reducedMotion="user" transition={MATERIAL_SPRING}>{children}</MotionConfig>;
}
