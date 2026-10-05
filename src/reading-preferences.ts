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
