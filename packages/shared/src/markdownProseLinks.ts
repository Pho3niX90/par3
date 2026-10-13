import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

type MarkdownNode = {
  readonly type: string;
  readonly position?:
    | {
        readonly start: { readonly offset?: number | undefined };
        readonly end: { readonly offset?: number | undefined };
      }
    | undefined;
  readonly children?: readonly MarkdownNode[] | undefined;
};

const parser = unified().use(remarkParse).use(remarkGfm);
const SKIPPED_TYPES = new Set([
  "link",
  "linkReference",
  "image",
  "imageReference",
  "code",
  "inlineCode",
  "html",
  "definition",
]);

/**
 * Turns each match of a global `pattern` in Markdown prose into `[match](url)`, leaving code,
 * URLs, HTML, and existing links alone. `link` returns the URL for a match, or null to skip it.
 * For renderers that take a Markdown string; a remark pipeline should transform its tree instead.
 */
export function linkMarkdownProse(
  markdown: string,
  pattern: RegExp,
  link: (match: RegExpMatchArray) => string | null,
): string {
  const edits: { start: number; end: number; value: string }[] = [];
  const visit = (node: MarkdownNode) => {
    if (SKIPPED_TYPES.has(node.type)) return;
    if (node.type === "text") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      // Work on source slices so escaped references and Markdown offsets stay intact.
      const source = markdown.slice(start, end);
      for (const match of source.matchAll(pattern)) {
        const url = link(match);
        if (url === null) continue;
        edits.push({
          start: start + match.index,
          end: start + match.index + match[0].length,
          value: `[${match[0]}](${url})`,
        });
      }
    } else if ("children" in node) {
      let protectedHtmlDepth = 0;
      for (const child of node.children ?? []) {
        if (child.type === "html") {
          const start = child.position?.start.offset;
          const end = child.position?.end.offset;
          const tag = start === undefined || end === undefined ? "" : markdown.slice(start, end);
          for (const match of tag.matchAll(/<(\/)?(?:a|code|pre|script|style)(?=[\s>])[^>]*>/gi)) {
            protectedHtmlDepth = Math.max(0, protectedHtmlDepth + (match[1] ? -1 : 1));
          }
        } else if (protectedHtmlDepth === 0) visit(child);
      }
    }
  };
  visit(parser.parse(markdown));
  for (let index = edits.length - 1; index >= 0; index--) {
    const edit = edits[index]!;
    markdown = markdown.slice(0, edit.start) + edit.value + markdown.slice(edit.end);
  }
  return markdown;
}
