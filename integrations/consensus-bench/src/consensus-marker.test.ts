import { describe, expect, test } from "vitest";
import { extractMarkerNums } from "./consensus-marker.js";

describe("extractMarkerNums", () => {
  test("extracts numbers from the newer 'consensus N' / '#CN' marker format", () => {
    const content = `lead text <!-- DO NOT CHANGE preceding sentence; see [[Talk:Donald Trump#C70|consensus 70]]. --> more`;
    expect(extractMarkerNums(content)).toEqual([70]);
  });

  test("extracts numbers from the older 'Current consensus]], item N' format", () => {
    const content = `lead <!-- without prior consensus; see [[Talk:Donald Trump#Current consensus]], item 52. --> body`;
    expect(extractMarkerNums(content)).toEqual([52]);
  });

  test("collects multiple distinct markers across comments, deduped and sorted", () => {
    const content = `
      a <!-- per consensus 76 --> b
      c <!-- see [[#Current consensus]], item 9 --> d
      e <!-- [[#C70|consensus 70]] also item 70 --> f`;
    expect(extractMarkerNums(content)).toEqual([9, 70, 76]);
  });

  test("ignores numbers in comments that don't mention consensus, and body text outside comments", () => {
    const content = `governed item 70 in the body <!-- a plain note, item 5, no keyword --> tail`;
    expect(extractMarkerNums(content)).toEqual([]);
  });
});
