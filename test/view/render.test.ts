import { describe, expect, it } from "vitest";
import { escHtml, jsonForScript, renderMarkdown } from "../../src/view/render.js";

describe("view render (slice C)", () => {
  it("renders gfm markdown to html", () => {
    const html = renderMarkdown("# Title\n\nSome **bold** text.\n");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
  });

  it("sanitizes an embedded script tag out of the body", () => {
    const html = renderMarkdown("Hello\n\n<script>alert(1)</script>\n");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("alert(1)");
  });

  it("strips a javascript: link protocol", () => {
    const html = renderMarkdown("[click](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
  });

  it("escHtml neutralizes angle brackets and quotes", () => {
    expect(escHtml(`<img src=x onerror="y">`)).toBe("&lt;img src=x onerror=&quot;y&quot;&gt;");
  });

  it("jsonForScript escapes a </script> breakout and line separators", () => {
    const out = jsonForScript({ s: "</script>\u2028x" });
    expect(out).not.toContain("</script>");
    expect(out).toContain("\\u003c");
    expect(out).toContain("\\u2028");
    expect(JSON.parse(out)).toEqual({ s: "</script>\u2028x" });
  });
});
