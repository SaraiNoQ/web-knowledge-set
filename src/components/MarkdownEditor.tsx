import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo, undoDepth, redoDepth } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { Compartment, EditorState, StateEffect, StateField } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder,
  showTooltip,
  type Tooltip,
} from "@codemirror/view";
import { INLINE_FORMATS, inlineFormat, inlineFormatActive, blockFormat, insertFormat, type BlockFormat, type InsertFormat } from "../markdown-commands";
import { IconButton, Select } from "./ui/Controls";

const showFormats = StateEffect.define<boolean>();
const formatsVisible = StateField.define<boolean>({
  create: () => false,
  update: (visible, transaction) => {
    for (const effect of transaction.effects) if (effect.is(showFormats)) return effect.value;
    return transaction.selection ? true : visible;
  },
});

const selectionFormats = showTooltip.computeN([formatsVisible, "selection", EditorState.readOnly], (state) => {
  const { from, to, empty } = state.selection.main;
  if (!state.field(formatsVisible) || empty || state.readOnly) return [];
  return [{
    pos: from, end: to, above: true, strictSide: false,
    create(view) {
      const dom = document.createElement("div");
      dom.className = "markdown-selection-toolbar";
      dom.setAttribute("role", "toolbar");
      dom.setAttribute("aria-label", "选中文字格式");
      dom.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        event.preventDefault(); event.stopPropagation();
        view.focus();
        view.dispatch({ effects: showFormats.of(false) });
      });
      for (const item of INLINE_FORMATS) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "ui-button ui-button--ghost ui-button--compact ui-icon-button";
        button.setAttribute("aria-label", item.label);
        button.setAttribute("aria-pressed", String(inlineFormatActive(state, item.id)));
        button.title = item.label;
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", width: "18", height: "18", fill: "none", stroke: "currentColor", "stroke-width": "1.7", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(key, value);
        const path = document.createElementNS(svg.namespaceURI, "path");
        path.setAttribute("d", item.icon); svg.append(path); button.append(svg);
        button.addEventListener("mousedown", (event) => event.preventDefault());
        button.addEventListener("click", () => inlineFormat(item.id)(view));
        dom.append(button);
      }
      return { dom };
    },
  } satisfies Tooltip];
});

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  toolbarHost?: HTMLElement | null;
}

const paperTheme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "transparent",
    color: "var(--ink)",
    fontSize: "var(--reading-font-size, 15px)",
  },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    lineHeight: "1.75",
    padding: "20px 10px 42px 0",
  },
  ".cm-content": {
    caretColor: "var(--vermilion)",
    maxWidth: "820px",
    padding: "0 26px",
  },
  ".cm-line": { padding: "0 2px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--vermilion)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "rgba(187, 61, 40, .16)",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--ink-faint)",
    border: "0",
    paddingLeft: "7px",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "var(--vermilion)",
  },
  ".cm-focused": { outline: "none" },
});

export interface MarkdownEditorHandle { jumpTo: (offset: number) => void }

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(function MarkdownEditor({ value, onChange, readOnly = false, toolbarHost }, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  useImperativeHandle(ref, () => ({ jumpTo(offset) {
    const view = viewRef.current;
    if (!view) return;
    const position = Math.max(0, Math.min(offset, view.state.doc.length));
    view.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: "start" }) });
    view.focus();
  } }), []);
  const onChangeRef = useRef(onChange);
  const readOnlyCompartment = useRef(new Compartment());
  const [tools, setTools] = useState({ active: [] as string[], undo: false, redo: false });

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          drawSelection(),
          history(),
          markdown(),
          placeholder("开始记录… 支持 Markdown，可选中文字设置格式"),
          formatsVisible,
          selectionFormats,
          EditorView.domEventHandlers({
            focus: (_event, view) => { view.dispatch({ effects: showFormats.of(true) }); },
            blur: (event, view) => {
              if (!(event.relatedTarget instanceof Node) || !view.dom.contains(event.relatedTarget)) view.dispatch({ effects: showFormats.of(false) });
            },
          }),
          EditorView.lineWrapping,
          EditorState.tabSize.of(2),
          readOnlyCompartment.current.of(EditorState.readOnly.of(readOnly)),
          EditorView.contentAttributes.of({
            "aria-label": "Markdown 编辑器",
            "aria-multiline": "true",
            tabindex: "0",
            spellcheck: "true",
          }),
          keymap.of([
            ...INLINE_FORMATS.map((item) => ({ key: item.key, run: inlineFormat(item.id) })),
            { key: "Escape", run: (view) => { if (!view.state.field(formatsVisible) || view.state.selection.main.empty) return false; view.dispatch({ effects: showFormats.of(false) }); return true; } },
            ...defaultKeymap, ...historyKeymap, indentWithTab,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
            if (update.docChanged || update.selectionSet) {
              const active = INLINE_FORMATS.filter((item) => inlineFormatActive(update.state, item.id)).map((item) => item.id);
              const canUndo = undoDepth(update.state) > 0, canRedo = redoDepth(update.state) > 0;
              setTools((previous) => previous.undo === canUndo && previous.redo === canRedo && previous.active.join() === active.join() ? previous : { active, undo: canUndo, redo: canRedo });
            }
          }),
          paperTheme,
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // CodeMirror owns its lifecycle; document changes are synchronized below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: readOnlyCompartment.current.reconfigure(EditorState.readOnly.of(readOnly)) });
  }, [readOnly]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    });
  }, [value]);

  const run = (command: (view: EditorView) => boolean) => { if (viewRef.current && !readOnly) command(viewRef.current); };
  const runFromMenu = (command: (view: EditorView) => boolean) => {
    run(command);
    // The shared Select restores its own trigger first; return to the insertion.
    requestAnimationFrame(() => viewRef.current?.focus());
  };
  const toolbar = <div className="markdown-format-toolbar" role="toolbar" aria-label="Markdown 格式工具">
      <Select density="compact" aria-label="段落格式" value="" disabled={readOnly} onChange={(event) => runFromMenu(blockFormat(event.target.value as BlockFormat))}>
        <option value="" disabled>段落</option><option value="paragraph">正文</option><option value="h1">一级标题</option><option value="h2">二级标题</option><option value="h3">三级标题</option>
      </Select>
      <div className="markdown-tool-group">
        {INLINE_FORMATS.map((item) => <IconButton key={item.id} label={item.label} title={`${item.label}（${item.key.replace("Mod-", "⌘ / Ctrl+")}）`} aria-pressed={tools.active.includes(item.id)} disabled={readOnly} onMouseDown={(event) => event.preventDefault()} onClick={() => run(inlineFormat(item.id))}><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={item.icon} /></svg></IconButton>)}
      </div>
      <Select density="compact" aria-label="插入 Markdown" value="" disabled={readOnly} onChange={(event) => {
        const id = event.target.value;
        runFromMenu(["quote", "bullet", "ordered", "task"].includes(id) ? blockFormat(id as BlockFormat) : insertFormat(id as InsertFormat));
      }}><option value="" disabled>插入</option><option value="quote">引用</option><option value="bullet">项目列表</option><option value="ordered">编号列表</option><option value="task">待办清单</option><option value="codeblock">代码段落</option><option value="table">表格</option><option value="math">公式</option><option value="divider">分隔线</option></Select>
      <div className="markdown-tool-group markdown-history-tools">
        <IconButton label="撤销" title="撤销（⌘ / Ctrl+Z）" disabled={readOnly || !tools.undo} onMouseDown={(event) => event.preventDefault()} onClick={() => run(undo)}><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="m8 4-5 5 5 5M3 9h11a6 6 0 0 1 0 12" /></svg></IconButton>
        <IconButton label="重做" title="重做（⌘ / Ctrl+Shift+Z）" disabled={readOnly || !tools.redo} onMouseDown={(event) => event.preventDefault()} onClick={() => run(redo)}><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="m16 4 5 5-5 5m5-5H10a6 6 0 0 0 0 12" /></svg></IconButton>
      </div>
    </div>;
  return <div className="markdown-editor">
    {toolbarHost ? createPortal(toolbar, toolbarHost) : toolbar}
    <div className="markdown-editor-host" ref={hostRef} />
  </div>;
});
