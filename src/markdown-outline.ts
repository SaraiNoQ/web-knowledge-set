import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

export interface OutlineHeading { offset: number; depth: number; title: string; ancestors: number[] }

export function markdownOutline(markdown: string): OutlineHeading[] {
  const headings: OutlineHeading[] = [];
  const parents: OutlineHeading[] = [];
  const tree = parser.parse(markdown);
  type Node = { type: string; value?: string; alt?: string | null; children?: Node[]; depth?: number; position?: { start: { offset?: number } } };
  const text = (node: Node): string => node.value ?? node.alt ?? node.children?.map(text).join("") ?? "";
  const visit = (node: Node) => {
    if (node.type === "heading") {
      const depth = node.depth!;
      while (parents.length && parents[parents.length - 1].depth >= depth) parents.pop();
      const heading = { offset: node.position!.start.offset!, depth, title: text(node) || "无标题", ancestors: parents.map((parent) => parent.offset) };
      headings.push(heading);
      parents.push(heading);
    } else node.children?.forEach(visit);
  };
  visit(tree);
  return headings;
}
