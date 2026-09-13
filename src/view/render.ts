// Server-side render helpers for `daftari view`. The markdown→HTML pipeline is
// the standard unified stack with rehype-sanitize, so untrusted document bodies
// cannot inject script or dangerous-protocol links into the viewer. Pure and
// synchronous (every plugin here is sync), so page builders can call it inline.

import { common, createLowlight } from "lowlight";
import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype)
  .use(rehypeSanitize)
  .use(rehypeStringify);

// Render a markdown document body to sanitized HTML. rehype-sanitize's default
// schema drops <script>, event handlers, and non-safe URL protocols.
export function renderMarkdown(md: string): string {
  return String(processor.processSync(md));
}

// One heading captured for a document's table of contents.
export interface TocEntry {
  depth: number; // 1..3
  text: string;
  id: string;
}

// A minimal structural view of a hast node — enough for a single post-sanitize
// walk without pulling in @types/hast at call sites.
interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

function walk(node: HastNode, fn: (n: HastNode) => void): void {
  fn(node);
  if (node.children) for (const child of node.children) walk(child, fn);
}

function textContent(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  if (!node.children) return "";
  return node.children.map(textContent).join("");
}

function slugify(text: string): string {
  const base = text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return base.length > 0 ? base : "section";
}

const HEADING_TAGS = new Set(["h1", "h2", "h3"]);

// Fenced-code highlighting runs post-sanitize, like the link/heading pass
// below: it walks the already-sanitized tree and only ever writes class names
// it generates itself (lowlight's fixed "hljs-*" token set, plus our own
// "hljs"/"language-*" markers), never anything derived from document text.
// `common` is a ~35-language subset of highlight.js's full grammar catalogue —
// enough for everyday fenced code without pulling every grammar into memory
// (the dep-caution tradeoff: highlight.js ships all grammars on disk, but only
// the ones in `common` are ever required at runtime).
const lowlight = createLowlight(common);
const LANGUAGE_CLASS = /^language-(\S+)$/;

function highlightCodeBlock(pre: HastNode): void {
  const code = pre.children?.find((c) => c.type === "element" && c.tagName === "code");
  if (!code) return;
  const classNames = code.properties?.className;
  const classList = Array.isArray(classNames) ? classNames.map(String) : [];
  const langClass = classList.find((c) => LANGUAGE_CLASS.test(c));
  const lang = langClass?.match(LANGUAGE_CLASS)?.[1];
  if (!lang || !lowlight.registered(lang)) return;

  const highlighted = lowlight.highlight(lang, textContent(code));
  code.children = (highlighted.children ?? []) as HastNode[];
  code.properties = { ...code.properties, className: ["hljs", `language-${lang}`] };
}

// Render a DOCUMENT body: sanitized HTML plus, applied AFTER sanitize (so we
// only add attributes we control):
//   - in-vault link resolution — a relative link to another vault doc becomes
//     /doc/<canonical>, resolved by the SAME resolver backlinks use so the two
//     never drift. External/anchor/absolute links are untouched.
//   - heading anchors + a collected table of contents (h1–h3).
//   - fenced code block syntax highlighting (see highlightCodeBlock above).
export function renderDocBody(
  md: string,
  opts: { resolveLink?: (rawTarget: string) => string | null } = {},
): { html: string; toc: TocEntry[] } {
  const toc: TocEntry[] = [];
  const usedIds = new Set<string>();

  const docProcessor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    .use(rehypeSanitize)
    .use(() => (tree: unknown) => {
      walk(tree as HastNode, (node) => {
        if (node.type !== "element") return;

        if (node.tagName === "a" && opts.resolveLink) {
          const href = node.properties?.href;
          // Only rewrite in-vault relative targets: skip scheme://, mailto:,
          // root-absolute, and pure #anchor links.
          if (typeof href === "string" && !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(href)) {
            const bare = href.split("#")[0] ?? href;
            const hit = opts.resolveLink(bare);
            if (hit) {
              node.properties = node.properties ?? {};
              node.properties.href = `/doc/${encodeURI(hit)}`;
            }
          }
        }

        if (node.tagName === "pre") {
          highlightCodeBlock(node);
        }

        if (node.tagName && HEADING_TAGS.has(node.tagName)) {
          const text = textContent(node).trim();
          if (text.length === 0) return;
          let id = slugify(text);
          let n = 1;
          while (usedIds.has(id)) {
            n += 1;
            id = `${slugify(text)}-${n}`;
          }
          usedIds.add(id);
          node.properties = node.properties ?? {};
          if (typeof node.properties.id !== "string") node.properties.id = id;
          toc.push({ depth: Number(node.tagName[1]), text, id: node.properties.id as string });
        }
      });
    })
    .use(rehypeStringify);

  const html = String(docProcessor.processSync(md));
  return { html, toc };
}

// Escape a string for interpolation into HTML text/attribute context.
export function escHtml(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// Serialize a value for safe embedding inside an inline <script>. JSON.stringify
// alone is unsafe there: an unescaped "<" lets a "</script>" in the data close
// the element early (breakout), and U+2028/U+2029 are valid JSON but illegal raw
// in a JS string. Escaping them keeps the payload inert and JSON-identical.
export function jsonForScript(value: unknown): string {
  const LINE_SEPARATOR = String.fromCharCode(0x2028);
  const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .split(LINE_SEPARATOR)
    .join("\\u2028")
    .split(PARAGRAPH_SEPARATOR)
    .join("\\u2029");
}
