// Server-side render helpers for `daftari view`. The markdown→HTML pipeline is
// the standard unified stack with rehype-sanitize, so untrusted document bodies
// cannot inject script or dangerous-protocol links into the viewer. Pure and
// synchronous (every plugin here is sync), so page builders can call it inline.

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

// Escape a string for interpolation into HTML text/attribute context.
export function escHtml(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Serialize a value for safe embedding inside an inline <script>. JSON.stringify
// alone is unsafe there: an unescaped "<" lets a "</script>" in the data close
// the element early (breakout), and U+2028/U+2029 are valid JSON but illegal raw
// in a JS string. Escaping them keeps the payload inert and JSON-identical.
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
