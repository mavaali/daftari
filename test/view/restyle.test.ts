import { describe, expect, it } from "vitest";
import { type DocBannerView, renderDocPage, renderIndexPage } from "../../src/view/pages.js";

const fm = {
  title: "A",
  collection: "pricing",
  status: "canonical",
  confidence: "high",
  provenance: "direct",
  tier: null,
  tags: [] as string[],
};

describe("viewer P1.5 — epistemic-first visual contract", () => {
  it("doc page leads with a standing strip: status badge + confidence meter", () => {
    const html = renderDocPage({ path: "a.md", frontmatter: fm, bodyHtml: "", backlinks: [] });
    expect(html).toContain(`class="standing"`);
    expect(html).toContain("badge"); // status badge
    expect(html).toContain(`class="meter"`); // confidence meter
    // high confidence → three lit good segments
    expect((html.match(/seg on-good/g) ?? []).length).toBe(3);
  });

  it("renders a decay chip and a contested flag when present", () => {
    const html = renderDocPage({
      path: "a.md",
      frontmatter: { ...fm, status: "draft", confidence: "low" },
      bodyHtml: "",
      backlinks: [],
      decayLevel: "warn",
      contestedCount: 2,
    });
    expect(html).toContain("warn"); // decay chip tone
    expect(html).toContain("contested×2");
    // low confidence → one lit bad segment
    expect((html.match(/seg on-bad/g) ?? []).length).toBe(1);
  });

  it("a fresh doc still shows a positive 'fresh' chip (health is legible too)", () => {
    const html = renderDocPage({ path: "a.md", frontmatter: fm, bodyHtml: "", backlinks: [] });
    expect(html).toContain("fresh");
  });

  it("banners are labeled and colored by kind", () => {
    const banners: DocBannerView[] = [
      { kind: "decay", text: "past ttl" },
      { kind: "structural", text: "orphan" },
    ];
    const html = renderDocPage({
      path: "a.md",
      frontmatter: fm,
      bodyHtml: "",
      backlinks: [],
      banners,
    });
    expect(html).toContain(`banner bad`); // decay → bad tone
    expect(html).toContain(`banner warn`); // structural → warn tone
    expect(html).toContain("decay");
    expect(html).toContain("structure");
  });

  it("index rows carry per-doc standing dots and a status column", () => {
    const html = renderIndexPage([
      {
        collection: "pricing",
        docs: [
          { path: "pricing/a.md", title: "Alpha", status: "canonical", confidence: "high" },
          { path: "pricing/b.md", title: "Beta", status: "draft", confidence: "low" },
        ],
      },
    ]);
    expect(html).toContain(`class="std"`);
    expect(html).toContain("dot good"); // canonical/high → good dot
    expect(html).toContain("dot dim"); // draft → dim status dot
    expect(html).toContain("dot bad"); // low confidence → bad dot
  });
});
