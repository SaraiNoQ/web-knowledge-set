import { useEffect, useRef, useState } from "react";
import { MarkdownStyleSelect } from "./MarkdownStyleSelect";
import { AiSettings } from "./AiSettings";
import { Button, Select } from "./ui/Controls";
import { DEFAULT_READING_MARGIN, normalizeReadingMargin, saveReadingMargin, DEFAULT_READING_TEXT, READING_FONTS, READING_STYLES, normalizeReadingText, saveReadingText, type ReadingTextSettings } from "../reading-preferences";

export function WorkspaceSettings({ cloud, semanticRefresh, onClose, readingMargin, onReadingMarginChange, readingText, onReadingTextChange }: {
  cloud: boolean; semanticRefresh: number; onClose: () => void;
  readingMargin: number; onReadingMarginChange: (value: number) => void;
  readingText: ReadingTextSettings; onReadingTextChange: (value: ReadingTextSettings) => void;
}) {
  const [section, setSection] = useState("ai");
  const readingSettingsRef = useRef<HTMLDivElement>(null);
  const [numberDraft, setNumberDraft] = useState({ fontSize: String(readingText.fontSize), lineHeight: String(readingText.lineHeight), letterSpacing: String(readingText.letterSpacing) });
  useEffect(() => setNumberDraft({ fontSize: String(readingText.fontSize), lineHeight: String(readingText.lineHeight), letterSpacing: String(readingText.letterSpacing) }), [readingText]);
  useEffect(() => {
    const root = readingSettingsRef.current;
    if (!root) return;
    const stepFocusedNumber = (event: WheelEvent) => {
      const input = event.target instanceof HTMLInputElement && event.target.type === "number" ? event.target : null;
      if (!input || !input.closest(".reading-number") || document.activeElement !== input || event.deltaY === 0 || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      const previous = input.value;
      try { event.deltaY < 0 ? input.stepUp() : input.stepDown(); } catch { return; }
      if (input.value !== previous) input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    root.addEventListener("wheel", stepFocusedNumber, { passive: false });
    return () => root.removeEventListener("wheel", stepFocusedNumber);
  }, []);
  const [storageFailed, setStorageFailed] = useState(false);
  const changeMargin = (value: number) => {
    const normalized = normalizeReadingMargin(value);
    onReadingMarginChange(normalized); setStorageFailed(!saveReadingMargin(normalized));
  };
  const changeText = (value: Partial<ReadingTextSettings>) => {
    const normalized = normalizeReadingText({ ...readingText, ...value });
    onReadingTextChange(normalized); setStorageFailed(!saveReadingText(normalized));
  };
  return <main className="workspace-settings" aria-labelledby="workspace-settings-title">
    <header><div><h1 id="workspace-settings-title">设置</h1><p>调整阅读体验与 AI 服务。</p></div><Button onClick={onClose}>返回资料库</Button></header>
    <div className="settings-layout">
      <nav className="settings-navigation" aria-label="设置分类">
        <Button type="button" aria-current={section === "reading" ? "page" : undefined} onClick={() => setSection("reading")}>阅读与显示</Button>
        <Button type="button" aria-current={section === "ai" ? "page" : undefined} onClick={() => setSection("ai")}>AI 派生设置</Button>
      </nav>
      <div className="settings-content">
        <section hidden={section !== "reading"} aria-labelledby="reading-settings-title">
          <h2 id="reading-settings-title">阅读与显示</h2>
          <div ref={readingSettingsRef} className="reading-setting">
            <div className="reading-control"><span>Markdown 展示风格</span><MarkdownStyleSelect value={readingText} onChange={changeText} /></div>
            <p className="reading-style-description">{READING_STYLES[readingText.style].description}。风格切换会应用推荐字体与行距，字号、字距和留白保持你的设置。</p>
            <div className="reading-control"><label htmlFor="reading-margin">正文两侧总留白</label><div className="reading-number"><input type="number" aria-label="正文两侧总留白百分比" min={0} max={50} step={1} value={readingMargin} onChange={(event) => changeMargin(event.currentTarget.valueAsNumber)} /><span>%</span></div><input id="reading-margin" type="range" min={0} max={50} step={1} value={readingMargin} style={{ "--range-progress": `${readingMargin * 2}%` } as import("react").CSSProperties} onChange={(event) => changeMargin(event.currentTarget.valueAsNumber)} /></div>
            <div className="reading-control"><label htmlFor="reading-font">正文字体</label><Select aria-label="正文字体" id="reading-font" value={readingText.font} onChange={(event) => changeText({ font: event.target.value as ReadingTextSettings["font"] })}>{Object.entries(READING_FONTS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select></div>
            {([{ key: "fontSize", label: "正文字号", unit: "px", min: 12, max: 28, step: 1 }, { key: "lineHeight", label: "正文行间距", unit: "倍", min: 1.2, max: 2.8, step: .05 }, { key: "letterSpacing", label: "正文字间距", unit: "em", min: 0, max: .15, step: .01 }] as const).map((field) => <div className="reading-control" key={field.key}><label htmlFor={`reading-${field.key}`}>{field.label}</label><div className="reading-number"><input id={`reading-${field.key}`} aria-label={field.label} type="number" min={field.min} max={field.max} step={field.step} value={numberDraft[field.key]} onChange={(event) => { const value = event.currentTarget.value; const number = event.currentTarget.valueAsNumber; setNumberDraft((current) => ({ ...current, [field.key]: value })); if (value && number >= field.min && number <= field.max) changeText({ [field.key]: number }); }} onBlur={(event) => changeText({ [field.key]: event.currentTarget.valueAsNumber })} /><span>{field.unit}</span></div></div>)}
            <div className="reading-style-sample" data-reading-style={readingText.style} style={{ "--reading-font": `var(--font-${readingText.font})`, "--reading-font-size": `${readingText.fontSize}px`, "--reading-line-height": readingText.lineHeight, "--reading-letter-spacing": `${readingText.letterSpacing}em` } as import("react").CSSProperties}>
              <article className="reading-text-preview markdown-preview" style={{ paddingInline: `${readingMargin / 2}%` }} aria-label="阅读效果预览"><h2>留一段安静的阅读时间</h2><p>文字的大小、间距与宽度，共同决定阅读的节奏。调整到舒适的状态，让每一行内容都有呼吸的空间。</p><blockquote><p>把值得留下的想法，写成自己的知识。</p></blockquote><p>支持 <strong>重点</strong>、列表、表格与 <code>Markdown</code>。</p></article>
            </div>
            {storageFailed && <p role="status">设置已在当前页面生效，但浏览器无法保存；刷新后会恢复默认值。</p>}
            <div><Button onClick={() => { changeMargin(DEFAULT_READING_MARGIN); changeText(DEFAULT_READING_TEXT); }}>恢复默认阅读设置</Button></div>
          </div>
        </section>
        <div hidden={section !== "ai"}><AiSettings embedded cloud={cloud} semanticRefresh={semanticRefresh} onClose={onClose} /></div>
      </div>
    </div>
  </main>;
}
