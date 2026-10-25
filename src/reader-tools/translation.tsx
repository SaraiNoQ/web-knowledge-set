import { useEffect, useRef, useState } from "react";
import { TRANSLATION_LANGUAGES, type TranslationLanguage } from "../../shared/types";
import type { ReaderToolModule, ReaderToolViewProps } from "./runtime";
import { Button, Select } from "../components/ui/Controls";
import { useToast } from "../components/ui/Feedback";

function TranslationView({ api, selection }: ReaderToolViewProps) {
  const toast = useToast();
  const [language, setLanguage] = useState<TranslationLanguage>(() => { const value = api.storage.get<TranslationLanguage>("language", "zh-CN"); return Object.hasOwn(TRANSLATION_LANGUAGES, value) ? value : "zh-CN"; });
  const [output, setOutput] = useState(""), [busy, setBusy] = useState(false), [complete, setComplete] = useState(false), [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    request.current?.abort(); generation.current += 1;
    setOutput(""); setBusy(false); setComplete(false); setError("");
    return () => { request.current?.abort(); generation.current += 1; };
  }, [selection?.documentId, selection?.revision, selection?.anchor.quote, selection?.anchor.prefix, selection?.anchor.suffix, selection?.anchor.source, selection?.anchor.pageNumber, selection?.anchor.blockId, language]);
  const translate = async () => {
    if (!selection || busy) return;
    request.current?.abort();
    const controller = new AbortController(), current = ++generation.current;
    request.current = controller;
    setBusy(true); setError(""); setComplete(false); setOutput("");
    let result = "", timer = 0;
    const flush = () => { if (generation.current === current && !controller.signal.aborted) setOutput(result); };
    try {
      await api.translate(selection, language, (text) => { result += text; if (!timer) timer = window.setTimeout(() => { timer = 0; flush(); }, 80); }, controller.signal);
      if (generation.current === current && !controller.signal.aborted) { flush(); setComplete(true); }
    } catch (cause) { if (!controller.signal.aborted && generation.current === current) setError((cause as Error).message); }
    finally { window.clearTimeout(timer); if (generation.current === current) setBusy(false); }
  };
  return <div className="selection-translation">
    <label>目标语言<Select value={language} onChange={(event) => { const value = event.target.value as TranslationLanguage; setLanguage(value); try { api.storage.set("language", value); } catch { toast.error("语言已切换，但未保存设置。"); } }}>{Object.entries(TRANSLATION_LANGUAGES).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</Select></label>
    {selection ? <blockquote aria-label="待翻译选区">{selection.anchor.quote}</blockquote> : <p>先在正文、编辑器或论文中选择文字。</p>}
    <div className="reader-tool-actions"><Button disabled={!selection || busy} onClick={() => void translate()}>翻译选区</Button>{busy && <Button onClick={() => { request.current?.abort(); generation.current += 1; setBusy(false); setComplete(false); }}>取消</Button>}</div>
    {busy && <p role="status">正在翻译…</p>}
    {output && <pre className="selection-translation-output" aria-label="选区译文">{output}</pre>}
    {error && <p className="error-text" role="alert">{error}</p>}
    {output && <div className="reader-tool-actions"><Button onClick={() => void navigator.clipboard.writeText(output).then(() => toast.success("译文已复制。"), () => toast.error("无法复制，请手动选择译文。"))}>复制译文</Button><Button disabled={!complete || !selection} onClick={() => {
      if (selection) void api.saveExcerpt(selection, output, `翻译 · ${TRANSLATION_LANGUAGES[language]}`).then(() => toast.success("译文已保存为摘录，正文未修改。"), (cause) => toast.error((cause as Error).message));
    }}>保存译文摘录</Button></div>}
  </div>;
}

export const translationTool: ReaderToolModule = {
  manifest: { id: "translation", name: "划词翻译", version: "1.0.0", hostApiVersion: 1, permissions: ["selection.read", "translation.request", "storage.own", "annotations.create"] },
  command: { id: "translate-selection", title: "翻译选区", key: "t", altKey: true },
  selectionAction: { title: "翻译" }, Overlay: TranslationView, Panel: TranslationView,
};
