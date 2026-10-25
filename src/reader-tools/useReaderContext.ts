import { useEffect } from "react";
import { readerTools, type ReaderContext } from "./runtime";
import type { SourceAnchor } from "../../shared/reader-tools";

export function useReaderContext(context: ReaderContext | null, openDocument: (id: string) => void, locateEditor: (anchor: SourceAnchor) => boolean) {
  useEffect(() => { readerTools.setContext(context); }, [context?.id, context?.revision, context?.title, context?.kind, context?.folderId, context?.blockedReason]);
  useEffect(() => { readerTools.configure({ openDocument, locateEditor }); });
  useEffect(() => () => { readerTools.setContext(null); }, []);
}
