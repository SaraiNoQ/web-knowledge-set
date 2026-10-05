import { useState } from "react";
import { AiSettings } from "./AiSettings";
import { Button } from "./ui/Controls";
import { DEFAULT_READING_MARGIN, normalizeReadingMargin, saveReadingMargin } from "../reading-preferences";

export function WorkspaceSettings({ cloud, semanticRefresh, onClose, readingMargin, onReadingMarginChange }: {
  cloud: boolean; semanticRefresh: number; onClose: () => void;
  readingMargin: number; onReadingMarginChange: (value: number) => void;
}) {
  const [section, setSection] = useState("ai");
  const [storageFailed, setStorageFailed] = useState(false);
  const changeMargin = (value: number) => {
    const normalized = normalizeReadingMargin(value);
    onReadingMarginChange(normalized);
    setStorageFailed(!saveReadingMargin(normalized));
  };
  return <main className="workspace-settings" aria-labelledby="workspace-settings-title">
    <header><div><h1 id="workspace-settings-title">设置</h1><p>调整阅读体验与 AI 服务。</p></div><Button onClick={onClose}>返回资料库</Button></header>
    <div className="settings-layout">
      <nav className="settings-navigation" aria-label="设置分类">
        <button type="button" aria-current={section === "reading" ? "page" : undefined} onClick={() => setSection("reading")}>阅读与显示</button>
        <button type="button" aria-current={section === "ai" ? "page" : undefined} onClick={() => setSection("ai")}>AI 派生设置</button>
      </nav>
      <div className="settings-content">
        <section hidden={section !== "reading"} aria-labelledby="reading-settings-title">
          <h2 id="reading-settings-title">阅读与显示</h2><p>正文宽度随阅读区域自动变化，也适用于打开大纲后的布局。</p>
          <div className="reading-setting">
            <label htmlFor="reading-margin">正文两侧总留白 <span><input type="number" aria-label="正文两侧总留白百分比" min={0} max={50} step={1} value={readingMargin} onChange={(event) => changeMargin(event.currentTarget.valueAsNumber)} /> %</span></label>
            <input id="reading-margin" type="range" min={0} max={50} step={1} value={readingMargin} onChange={(event) => changeMargin(event.currentTarget.valueAsNumber)} aria-describedby="reading-margin-description" />
            <div className="reading-margin-preview" aria-hidden="true"><span style={{ width: `${readingMargin / 2}%` }} /><div>正文区域 · {100 - readingMargin}%</div><span style={{ width: `${readingMargin / 2}%` }} /></div>
            <p id="reading-margin-description">0% 使用整个正文区域；50% 时左右各留 25%。自动保存于当前浏览器，不影响文章内容。</p>
            {storageFailed && <p role="status">设置已在当前页面生效，但浏览器无法保存；刷新后会恢复默认值。</p>}
            <div><Button onClick={() => changeMargin(DEFAULT_READING_MARGIN)}>恢复默认留白</Button></div>
          </div>
        </section>
        <div hidden={section !== "ai"}><AiSettings embedded cloud={cloud} semanticRefresh={semanticRefresh} onClose={onClose} /></div>
      </div>
    </div>
  </main>;
}
