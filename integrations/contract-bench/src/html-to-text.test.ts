import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { decodeEntities, htmlToText, stripStructure } from "./html-to-text.js";
import { parseCitations } from "./citation-parse.js";

describe("decodeEntities", () => {
  test("decodes named entities", () => {
    expect(decodeEntities("AT&amp;T &lt;x&gt; &quot;q&quot; a&nbsp;b &sect;5")).toBe('AT&T <x> "q" a b §5');
  });
  test("decodes decimal numeric entities incl. the curly quotes parseCitations needs", () => {
    expect(decodeEntities("&#8220;Commitment&#8221; means&#58; &#8217;")).toBe("“Commitment” means: ’");
  });
  test("decodes hex numeric entities", () => {
    expect(decodeEntities("a&#x2014;b")).toBe("a—b");
  });
  test("maps cp1252 high-range smart punctuation", () => {
    expect(decodeEntities("&#147;x&#148; y&#146;s &#150;")).toBe("“x” y’s –");
  });
  test("leaves an unknown named entity intact", () => {
    expect(decodeEntities("&bogus; &amp;")).toBe("&bogus; &");
  });
});

describe("stripStructure", () => {
  test("removes inline tags with NO inserted whitespace (keeps a tag-split token whole)", () => {
    expect(stripStructure("&#8220;<b>Commit</b>ment&#8221;")).toBe("&#8220;Commitment&#8221;");
    expect(stripStructure("5.<u>1</u>")).toBe("5.1");
  });
  test("turns block tags into a single space boundary", () => {
    expect(stripStructure("<p>A.</p><p>B.</p>").trim()).toBe("A.  B.");
  });
  test("drops comments, script, and style content", () => {
    expect(stripStructure("a<!--x-->b<script>z()</script>c<style>p{}</style>d")).toBe("abcd");
  });
});

const amd1 = readFileSync(new URL("./__fixtures__/ngs/amd1.htm", import.meta.url), "utf8");

describe("htmlToText", () => {
  test("strips tags then decodes (literal < from &lt; is not re-stripped)", () => {
    expect(htmlToText("<p>a &lt;b&gt; c</p>").trim()).toBe("a <b> c");
  });
  test("collapses all whitespace (incl. decoded nbsp) to single spaces", () => {
    expect(htmlToText("x\n\n  y&#160;&#160;z")).toBe("x y z");
  });
  test("does NOT mint a spurious sentence boundary inside a dotted clause number", () => {
    // "5.1" split by an inline tag must remain a non-boundary "5.1".
    const out = htmlToText("Section 5.<b>1</b> of the Agreement is amended.");
    expect(out).toContain("Section 5.1 of");
  });
  test("documents the block-split limitation: a BLOCK tag inside a clause number splits it", () => {
    // Inline split is preserved (tested above). A block tag inserts a space,
    // so "5.<td>1</td>" degrades to "5. 1". EDGAR never splits a clause number
    // across a block element, so this is an accepted, documented limitation —
    // pinned here so it reads as understood, not overlooked.
    expect(htmlToText("Section 5.<td>1</td>")).toBe("Section 5. 1");
  });

  // --- ORACLE: real EDGAR HTML -> parseCitations recovers the verified term ---
  // op:"restate" depends on the "...respective entireties" (restate) phrase
  // being the nearest preceding TERM_OP_PATTERNS match before "Commitment"
  // means — verified live in gate-zero (spec). If this ever resolves to
  // op:"add" instead, the cause is phrase ORDERING in the real text, NOT
  // htmlToText — check that before touching the converter.
  test("oracle: amd-1 yields the Commitment defined-term restate as recoverable", () => {
    const text = htmlToText(amd1);
    expect(text).toContain("“Commitment” means"); // curly quotes decoded
    const cites = parseCitations(text);
    const commitment = cites.find((c) => c.clause === "Commitment");
    expect(commitment).toBeDefined();
    expect(commitment).toMatchObject({ op: "restate", recoverable: true });
  });
});
