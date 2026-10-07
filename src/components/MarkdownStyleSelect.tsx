import { READING_STYLES, applyReadingStyle, type ReadingStyle, type ReadingTextSettings } from "../reading-preferences";
import { Select } from "./ui/Controls";

export function MarkdownStyleSelect({ value, onChange }: { value: ReadingTextSettings; onChange: (value: ReadingTextSettings) => void }) {
  return <Select density="compact" wrapperClassName="markdown-style-select" aria-label="Markdown 展示风格" value={value.style} onChange={(event) => {
    const next = applyReadingStyle(value, event.target.value as ReadingStyle);
    onChange(next);
  }}>{Object.entries(READING_STYLES).map(([key, style]) => <option key={key} value={key}>{style.label}</option>)}</Select>;
}
