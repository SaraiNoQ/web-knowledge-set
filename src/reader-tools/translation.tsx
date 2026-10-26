import { useEffect, useRef, useState } from "react";
import { TRANSLATION_LANGUAGES, type TranslationLanguage } from "../../shared/types";
import type { ReaderToolApi, ReaderToolModule, ReaderToolViewProps } from "./runtime";
import { Button, Checkbox, Input, Select } from "../components/ui/Controls";
import { FileSelectButton } from "../components/ui/Uploads";
import { useToast } from "../components/ui/Feedback";
import { applicableGlossary, exportGlossary, importGlossary, mergeGlossary, readGlossary, type TranslationGlossary } from "./glossary";
import { ReaderInputError } from "../../shared/reader-tools";

const glossaryMessage = (cause: unknown) => cause instanceof ReaderInputError ? "每条术语需包含不超过 80 个字符的单行原词和译法，原词不能重复。" : (cause as Error).message;

function preferences(api: ReaderToolApi) {
  const value = api.storage.get<TranslationLanguage>("language", "zh-CN");
  return { language: Object.hasOwn(TRANSLATION_LANGUAGES, value) ? value : "zh-CN" as TranslationLanguage,
    automatic: api.storage.get<unknown>("automatic", false) === true,
    glossary: readGlossary(api.storage.get("glossary", { revision: 0, terms: [] })) };
}

function TranslationView({ api, selection, active = true }: ReaderToolViewProps) {
  const toast = useToast();
  const [prefs, setPrefs] = useState(() => preferences(api));
  const { language, automatic, glossary } = prefs;
  const [output, setOutput] = useState(""), [busy, setBusy] = useState(false), [complete, setComplete] = useState(false), [error, setError] = useState("");
  const [settingsError, setSettingsError] = useState(""), [glossaryError, setGlossaryError] = useState("");
  const [source, setSource] = useState(""), [target, setTarget] = useState("");
  const request = useRef<AbortController | null>(null), mode = useRef<"manual" | "auto">("manual"), generation = useRef(0);
  const selectionKey = selection ? JSON.stringify([selection.documentId, selection.revision, selection.anchor]) : "";
  const inputKey = JSON.stringify([selectionKey, language, glossary.revision, settingsError]);
  const refresh = () => {
    try { const next = preferences(api); setPrefs((old) => JSON.stringify(old) === JSON.stringify(next) ? old : next); setSettingsError(""); }
    catch (cause) { setSettingsError((cause as Error).message); }
  };
  useEffect(() => api.storage.subscribe(refresh), [api]);
  useEffect(() => {
    request.current?.abort(); generation.current += 1;
    setOutput(""); setBusy(false); setComplete(false); setError("");
    return () => { request.current?.abort(); generation.current += 1; };
  }, [inputKey]);
  const saveSetting = (key: string, value: unknown) => {
    try { api.storage.set(key, value); refresh(); return true; }
    catch (cause) { toast.error((cause as Error).message); return false; }
  };
  const translate = async (requestedMode: "manual" | "auto" = "manual") => {
    if (!selection || busy || settingsError || (requestedMode === "auto" && !active)) return;
    request.current?.abort();
    const controller = new AbortController(), current = ++generation.current;
    request.current = controller; mode.current = requestedMode;
    setBusy(true); setError(""); setComplete(false); setOutput("");
    let result = "", timer = 0;
    const flush = () => { if (generation.current === current && !controller.signal.aborted) setOutput(result); };
    try {
      await api.translate(selection, language, (text) => { result += text; if (!timer) timer = window.setTimeout(() => { timer = 0; flush(); }, 80); }, controller.signal,
        { glossary: applicableGlossary(glossary, selection.anchor.quote), glossaryRevision: glossary.revision });
      if (generation.current === current && !controller.signal.aborted) { flush(); setComplete(true); }
    } catch (cause) { if (!controller.signal.aborted && generation.current === current) setError((cause as Error).message); }
    finally { window.clearTimeout(timer); if (request.current === controller) request.current = null; if (generation.current === current) setBusy(false); }
  };
  const translateRef = useRef(translate); translateRef.current = translate;
  useEffect(() => {
    if (!automatic || !active || !selection || settingsError) return;
    const timer = window.setTimeout(() => void translateRef.current("auto"), 600);
    return () => { clearTimeout(timer); if (mode.current === "auto") request.current?.abort(); };
  }, [automatic, active, inputKey]);
  const saveGlossary = (next: TranslationGlossary) => {
    api.storage.set("glossary", next); refresh(); setGlossaryError("");
  };
  return <div className="selection-translation">
    <div className="selection-translation-controls"><label>目标语言<Select aria-label="目标语言" value={language} disabled={Boolean(settingsError)} onChange={(event) => saveSetting("language", event.target.value as TranslationLanguage)}>{Object.entries(TRANSLATION_LANGUAGES).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</Select></label>
    <div className="reader-tool-actions"><Button disabled={!selection || busy || Boolean(settingsError)} onClick={() => void translate()}>翻译选区</Button>{busy && <Button onClick={() => { request.current?.abort(); generation.current += 1; setBusy(false); setComplete(false); }}>取消</Button>}</div></div>
    <Checkbox wrapperClassName="translation-automatic" label="稳定选区后自动翻译" checked={automatic} disabled={Boolean(settingsError)} onChange={(event) => saveSetting("automatic", event.target.checked)} />
    <p className="translation-hint">开启后，仅在工具打开时把稳定选区发给已配置的模型。</p>
    {selection ? <blockquote aria-label="待翻译选区">{selection.anchor.quote}</blockquote> : <p>先在正文、编辑器或论文中选择文字。</p>}
    {busy && <p role="status">正在翻译…</p>}
    {output && <pre className="selection-translation-output" aria-label="选区译文">{output}</pre>}
    {(error || settingsError) && <p className="error-text" role="alert">{settingsError || error}</p>}
    {output && <div className="reader-tool-actions"><Button onClick={() => void navigator.clipboard.writeText(output).then(() => toast.success("译文已复制。"), () => toast.error("无法复制，请手动选择译文。"))}>复制译文</Button><Button disabled={!complete || !selection || Boolean(settingsError)} onClick={() => {
      if (selection) void api.saveExcerpt(selection, output, `翻译 · ${TRANSLATION_LANGUAGES[language]}`).then(() => toast.success("译文已保存为摘录，正文未修改。"), (cause) => toast.error((cause as Error).message));
    }}>保存译文摘录</Button></div>}
    <details className="translation-glossary"><summary>术语表（{glossary.terms.length}）</summary>
      <p className="translation-hint">保存在本浏览器，可导出备份。每次应用选区中匹配的最多 20 条术语。</p>
      <form onSubmit={(event) => { event.preventDefault(); try { saveGlossary(mergeGlossary(preferences(api).glossary, [{ source, target }])); setSource(""); setTarget(""); } catch (cause) { setGlossaryError(glossaryMessage(cause)); } }}>
        <label>原词<Input value={source} maxLength={80} disabled={Boolean(settingsError)} onChange={(event) => setSource(event.target.value)} /></label>
        <label>首选译法<Input value={target} maxLength={80} disabled={Boolean(settingsError)} onChange={(event) => setTarget(event.target.value)} /></label>
        <Button type="submit" disabled={Boolean(settingsError)}>添加术语</Button>
      </form>
      {glossary.terms.length > 0 && <ul>{glossary.terms.map((term) => <li key={term.source}><span><strong>{term.source}</strong><span>{term.target}</span></span><Button disabled={Boolean(settingsError)} aria-label={`删除术语：${term.source}`} onClick={() => { try { const current = preferences(api).glossary; saveGlossary({ revision: current.revision + 1, terms: current.terms.filter((entry) => entry.source !== term.source) }); } catch (cause) { setGlossaryError(glossaryMessage(cause)); } }}>删除</Button></li>)}</ul>}
      <div className="reader-tool-actions"><Button disabled={!glossary.terms.length} onClick={() => { const url = URL.createObjectURL(new Blob([exportGlossary(glossary)], { type: "application/json" })); const link = document.createElement("a"); link.href = url; link.download = "zhiye-glossary.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}>导出术语</Button>
      <FileSelectButton label="导入术语" inputLabel="导入术语文件" accept=".json,application/json" disabled={Boolean(settingsError)} onChange={(event) => {
        const file = event.currentTarget.files?.[0]; event.currentTarget.value = "";
        if (!file) return;
        if (file.size > 64 * 1024) { setGlossaryError("术语文件超过 64 KiB。"); return; }
        void file.text().then((text) => { saveGlossary(importGlossary(text, preferences(api).glossary)); toast.success("术语已合并导入。"); }).catch((cause) => setGlossaryError(glossaryMessage(cause)));
      }} /></div>
      {glossaryError && <p role="alert" className="error-text">{glossaryError}</p>}
    </details>
  </div>;
}

export const translationTool: ReaderToolModule = {
  manifest: { id: "translation", name: "划词翻译", version: "1.0.0", hostApiVersion: 1, storageVersion: 1, permissions: ["selection.read", "translation.request", "storage.own", "annotations.create"] },
  command: { id: "translate-selection", title: "翻译选区", key: "t", altKey: true },
  selectionAction: { title: "翻译" }, Overlay: TranslationView, Panel: TranslationView,
};
