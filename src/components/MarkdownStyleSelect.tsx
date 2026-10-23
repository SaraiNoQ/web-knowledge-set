import { READING_STYLES, applyReadingStyle, type ReadingStyle, type ReadingTextSettings } from "../reading-preferences";
import { Select, type UiDensity } from "./ui/Controls";

export function MarkdownStyleSelect({ value, onChange, density = "compact" }: { value: ReadingTextSettings; density?: UiDensity; onChange: (value: ReadingTextSettings) => void }) {
  return <Select density={density} wrapperClassName="markdown-style-select" aria-label="页面风格" value={value.style} onChange={(event) => {
    const next = applyReadingStyle(value, event.target.value as ReadingStyle);
    onChange(next);
  }}>{Object.entries(READING_STYLES).map(([key, style]) => <option key={key} value={key}>{style.label}</option>)}</Select>;
}
