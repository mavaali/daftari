// preamble — extract the linkage signal from an amendment's opening: its ordinal
// (First/Second/…), the BASE agreement's date ("dated as of <date>"), and the
// agreement type. The base date is what links an amendment to its master and
// separates two same-type chains for one filer. NOTE: an amendment's OWN date
// is often phrased "dated effective as of <date>" — we match "dated as of"
// (no "effective"), which skips the amendment's own date and lands on the base's.
const ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
};

export interface Preamble {
  ordinal: number;
  ordinalWord: string;
  baseDate: string;
  agreementType: string;
}

export function parsePreamble(text: string): Preamble | null {
  // 2500 is a generous head: in the known corpus the base date appears by
  // ~700 chars (NGS amd-1), so this leaves comfortable margin.
  const head = text.slice(0, 2500);
  const ordM = head.match(/\b(First|Second|Third|Fourth|Fifth|Sixth|Seventh|Eighth|Ninth|Tenth)\s+Amendment\b/i);
  if (!ordM) return null;
  const ordinalWord = ordM[1];
  const ordinal = ORDINALS[ordinalWord.toLowerCase()];
  // "dated as of <Month D, YYYY>" — but NOT "dated effective as of" (the
  // amendment's own date). Matching "dated as of" verbatim (the word
  // "effective" sits between "dated" and "as of" in the amendment's own
  // phrasing) naturally skips it and lands on the base's date. CORPUS
  // ASSUMPTION: this relies on amendments phrasing their OWN date as "dated
  // effective as of"; an amendment using bare "dated as of" for its own date
  // would match wrong. Verify on non-NGS chains before widening the query.
  // /i so "Dated as of" at a recital start (capital D) isn't a false negative.
  const dateM = head.match(/dated as of\s+([A-Z][a-z]+\s+\d{1,2},\s+\d{4})/i);
  if (!dateM) return null;
  const baseDate = dateM[1];
  const typeM = head.match(/Amendment\s+to\s+(?:the\s+)?(?:that\s+certain\s+)?([A-Za-z][A-Za-z ]*?Agreement)\b/i);
  const agreementType = (typeM ? typeM[1] : "Agreement").replace(/\s+/g, " ").trim();
  return { ordinal, ordinalWord, baseDate, agreementType };
}
