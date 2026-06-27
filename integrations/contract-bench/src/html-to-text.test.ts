import { describe, expect, test } from "vitest";
import { decodeEntities } from "./html-to-text.js";

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

import { stripStructure } from "./html-to-text.js";

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
