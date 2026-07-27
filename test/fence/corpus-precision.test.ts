import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type InjectionClass, injectionClasses } from "../../src/fence/detect.js";

// Kill condition 2 of the 2026-07-27 read-path fence spec: "the detector's
// false-positive rate is tolerable on real prose." This measures it against a
// real corpus — daftari's own docs/, 150 markdown files of technical writing —
// rather than against hand-written fixtures, which would only measure the
// author's imagination.
//
// The predecessor design cited 0.32%. That figure's denominator was inflated by
// stub files; measured here on prose it is an order of magnitude higher. The
// number below is a MEASUREMENT, not a target. If a change moves it, the right
// response is to look at what newly fired, not to raise the ceiling.

const DOCS = resolve("docs");

// Documents whose subject IS prompt injection. These contain instruction-shaped
// text on purpose — quoted payloads, regex patterns, attack examples. The
// detector firing on them is correct behaviour, so counting them as false
// positives would measure the corpus, not the detector.
const ABOUT_INJECTION = [
  "2026-07-26-memory-poisoning-defenses-design.md",
  "2026-07-26-memory-poisoning-defenses-challenge.md",
  "2026-07-27-memory-poisoning-read-path-fence-design.md",
];

// Ceiling for ordinary technical prose. Set from the measured rate with room
// for corpus growth, not from an aspiration.
const MAX_FLAGGED_RATIO = 0.05;

function markdownFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) markdownFiles(path, out);
    else if (path.endsWith(".md")) out.push(path);
  }
  return out;
}

function body(path: string): string {
  return readFileSync(path, "utf8").replace(/^---[\s\S]*?\n---\n/, "");
}

const isAboutInjection = (p: string) => ABOUT_INJECTION.some((name) => p.endsWith(name));

describe("detector precision on a real prose corpus", () => {
  const all = markdownFiles(DOCS);
  const ordinary = all.filter((p) => !isAboutInjection(p));

  it("has a corpus worth measuring against", () => {
    // Guards the measurement itself: if docs/ moves or shrinks, the ratio below
    // stops meaning anything and this fails first with a legible reason.
    expect(all.length).toBeGreaterThan(100);
    expect(ordinary.length).toBeGreaterThan(100);
  });

  it("flags at most 5% of ordinary technical prose", () => {
    const flagged = ordinary
      .map((p) => ({ path: p, classes: injectionClasses(body(p)) }))
      .filter((r) => r.classes.length > 0);

    const ratio = flagged.length / ordinary.length;
    // Named in the failure so a regression says WHICH document newly fired.
    const detail = flagged.map((f) => `${f.classes.join(",")} ${f.path}`).join("\n");
    expect(ratio, `flagged ${flagged.length}/${ordinary.length}:\n${detail}`).toBeLessThanOrEqual(
      MAX_FLAGGED_RATIO,
    );
  });

  it("still fires on documents that really do contain instruction-shaped text", () => {
    // Positive control. Without this, a detector that matched nothing at all
    // would pass the precision assertion with a perfect score.
    const present = all.filter(isAboutInjection);
    expect(present.length).toBe(ABOUT_INJECTION.length);
    for (const path of present) {
      expect(injectionClasses(body(path)).length, path).toBeGreaterThan(0);
    }
  });

  it("reports which classes drive the rate", () => {
    // Not an assertion about the corpus so much as a regression guard on the
    // shape of the problem: tool-solicitation dominates, because tool-call
    // syntax appears constantly in an engineering vault's prose. If that ever
    // stops being true the trade-off in MASKED_CLASSES deserves revisiting.
    const counts = new Map<InjectionClass, number>();
    for (const path of ordinary) {
      for (const cls of injectionClasses(body(path))) {
        counts.set(cls, (counts.get(cls) ?? 0) + 1);
      }
    }
    expect(counts.get("tool-solicitation") ?? 0).toBeGreaterThan(0);
    // No class should be quietly responsible for most of the corpus.
    for (const [cls, n] of counts) {
      expect(n / ordinary.length, `${cls} flags too much prose`).toBeLessThanOrEqual(
        MAX_FLAGGED_RATIO,
      );
    }
  });
});
