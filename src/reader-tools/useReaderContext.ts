import { useEffect } from "react";
import { readerTools, type ReaderContext } from "./runtime";
import type { SourceAnchor } from "../../shared/reader-tools";
import type { QuestionCitation } from "../../shared/study-types";

export function useReaderContext(context: ReaderContext | null, openDocument: (id: string) => void, locateEditor: (anchor: SourceAnchor) => boolean, openEvidence?: (citation:QuestionCitation)=>void) {
  useEffect(() => { readerTools.setContext(context); }, [context?.id, context?.revision, context?.title, context?.kind, context?.folderId, context?.blockedReason]);
  useEffect(() => { readerTools.configure({ openDocument, locateEditor, openEvidence }); });
  useEffect(() => () => { readerTools.setContext(null); }, []);
}
