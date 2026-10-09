const KEY = "zhiye:reading-margin";
export const DEFAULT_READING_MARGIN = 20;

export function normalizeReadingMargin(value: number) {
  return Number.isFinite(value) ? Math.min(50, Math.max(0, Math.round(value))) : DEFAULT_READING_MARGIN;
}

export function loadReadingMargin() {
  try {
    const value = localStorage.getItem(KEY);
    return value === null ? DEFAULT_READING_MARGIN : normalizeReadingMargin(Number(value));
  } catch { return DEFAULT_READING_MARGIN; }
}

export function saveReadingMargin(value: number) {
  try { localStorage.setItem(KEY, String(normalizeReadingMargin(value))); return true; }
  catch { return false; }
}
export const READING_FONTS = { serif: "衬线字体", sans: "无衬线字体", mono: "等宽字体" } as const;
export const READING_STYLES = {
  paper: { label: "纸页", description: "柔和排版，适合日常阅读", font: "serif", lineHeight: 1.95 },
  minimal: { label: "极简", description: "清爽排版，适合笔记清单", font: "sans", lineHeight: 1.8 },
  editorial: { label: "书刊", description: "突出标题，适合长篇文章", font: "serif", lineHeight: 2.1 },
  technical: { label: "技术", description: "紧凑排版，适合说明和代码", font: "sans", lineHeight: 1.7 },
} as const;
export type ReadingStyle = keyof typeof READING_STYLES;
export interface ReadingTextSettings { style: ReadingStyle; font: keyof typeof READING_FONTS; fontSize: number; lineHeight: number; letterSpacing: number }
export const DEFAULT_READING_TEXT: ReadingTextSettings = { style: "paper", font: "serif", fontSize: 16, lineHeight: 1.95, letterSpacing: 0 };
const TEXT_KEY = "zhiye:reading-text";
const bounded = (value: unknown, fallback: number, min: number, max: number, digits: number) => typeof value === "number" && Number.isFinite(value) ? Number(Math.max(min, Math.min(max, value)).toFixed(digits)) : fallback;
export function normalizeReadingText(value: unknown): ReadingTextSettings {
  const input = value && typeof value === "object" ? value as Partial<ReadingTextSettings> : {};
  return { style: input.style && Object.hasOwn(READING_STYLES, input.style) ? input.style : "paper", font: input.font && Object.hasOwn(READING_FONTS, input.font) ? input.font : "serif", fontSize: bounded(input.fontSize, 16, 12, 28, 0), lineHeight: bounded(input.lineHeight, 1.95, 1.2, 2.8, 2), letterSpacing: bounded(input.letterSpacing, 0, 0, .15, 2) };
}
export function applyReadingStyle(settings: ReadingTextSettings, style: ReadingStyle): ReadingTextSettings {
  const preset = READING_STYLES[style];
  return { ...settings, style, font: preset.font, lineHeight: preset.lineHeight };
}
export function loadReadingText() {
  try { return normalizeReadingText(JSON.parse(localStorage.getItem(TEXT_KEY) || "null")); } catch { return { ...DEFAULT_READING_TEXT }; }
}
export function saveReadingText(value: ReadingTextSettings) {
  try { localStorage.setItem(TEXT_KEY, JSON.stringify(normalizeReadingText(value))); return true; } catch { return false; }
}
