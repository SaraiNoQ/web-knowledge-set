import { useEffect, useRef, type Ref } from "react";
import { Tooltip } from "./ui/Tooltip";

export function LibraryViewSwitch({ map, onChange, listRef, active = true }: { map: boolean; onChange: (map: boolean) => void; listRef?: Ref<HTMLButtonElement>; active?: boolean }) {
  const mapButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!active || !map) return;
    let frame: number;
    let remainingFrames = 12;
    const focusWhenVisible = () => {
      const button = mapButton.current;
      if (!button) return;
      if (getComputedStyle(button).visibility === "visible" && button.getClientRects().length) button.focus();
      else if (--remainingFrames > 0) frame = window.requestAnimationFrame(focusWhenVisible);
    };
    frame = window.requestAnimationFrame(focusWhenVisible);
    return () => window.cancelAnimationFrame(frame);
  }, [active, map]);
  return (
    <div className={`library-view-toggle ${map ? "is-map" : ""}`} role="group" aria-label="资料库显示方式">
      <Tooltip content={map ? "返回列表" : "列表"} disabled={!active} placement="bottom" delay={200}>
        <button ref={listRef} type="button" aria-label={map ? "返回列表" : "列表"} aria-pressed={!map} onClick={() => onChange(false)}>
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6h11M9 12h11M9 18h11" /><path d="M4 6h.01M4 12h.01M4 18h.01" /></svg>
        </button>
      </Tooltip>
      <Tooltip content="知识地图" disabled={!active} placement="bottom" delay={200}>
        <button ref={mapButton} type="button" aria-label="知识地图" aria-pressed={map} onClick={() => onChange(true)}>
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="m7 7 10 2M7 7l3 10m7-8-7 8" /><circle cx="6" cy="5" r="3" /><circle cx="19" cy="10" r="3" /><circle cx="10" cy="20" r="3" /></svg>
        </button>
      </Tooltip>
    </div>
  );
}
