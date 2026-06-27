// preamble — extract the linkage signal from an amendment's opening: its ordinal
// (First/Second/…), the BASE agreement's date ("dated as of <date>"), and the
// agreement type. The base date is what links an amendment to its master and
// separates two same-type chains for one filer.
//
// CORPUS ASSUMPTION (validated against real EDGAR filers — NGS + PetroQuest):
// Most amendments put their OWN date in the title line ("EIGHTH AMENDMENT TO
// CREDIT AGREEMENT dated as of September 29, 2014 …"). The TRUE base date is
// referenced later in the recitals via a stable anchor:
//   "that certain [the] <Type> Agreement dated as of <BASE date>".
// We anchor on that recital phrase first; it cleanly separates the base date
// from the amendment's own date and is consistent across filers (PetroQuest's
// 8th–12th all resolve to base "October 2, 2008", collapsing into ONE chain).
// The recital lists the base FIRST, so the first anchor match wins.
//
// This recital anchor SUPERSEDES the earlier NGS-specific "dated as of" (vs
// "dated effective as of") trick. We keep that older behavior only as a FALLBACK
// for inputs without the "that certain … Agreement" anchor (e.g. reconstruct.ts's
// synthetic strings).
const ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15,
  sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20,
};

export interface Preamble {
  ordinal: number;
  ordinalWord: string;
  baseDate: string;
  agreementType: string;
}

export function parsePreamble(text: string): Preamble | null {
  // 2500 is a generous head: in the known corpus the base recital appears well
  // within this margin (PetroQuest base-ref offsets ~985/951, NGS ~700).
  const head = text.slice(0, 2500);
  // Ordinal word list extended past "Tenth" (to Twentieth). The document's own
  // title ordinal appears BEFORE the recitals, so with the full list the first
  // match is the title's — e.g. PetroQuest 11th's title "ELEVENTH AMENDMENT,
  // LIMITED CONSENT AND WAIVER TO CREDIT AGREEMENT" matches (the comma is a word
  // boundary) and "First Amendment" in the recitals no longer hijacks it.
  const ordM = head.match(
    /\b(First|Second|Third|Fourth|Fifth|Sixth|Seventh|Eighth|Ninth|Tenth|Eleventh|Twelfth|Thirteenth|Fourteenth|Fifteenth|Sixteenth|Seventeenth|Eighteenth|Nineteenth|Twentieth)\s+Amendment\b/i,
  );
  if (!ordM) return null;
  const ordinalWord = ordM[1];
  const ordinal = ORDINALS[ordinalWord.toLowerCase()];

  // Primary: recital anchor. "that certain [the] <Type> Agreement dated as of
  // <BASE date>" — group[1] = agreementType, group[2] = baseDate. First match
  // wins (the recital lists the base agreement before the prior amendments).
  const recitalM = head.match(
    /that certain\s+(?:the\s+)?([A-Za-z][A-Za-z ]*?Agreement)\s+dated as of\s+([A-Z][a-z]+\s+\d{1,2},\s+\d{4})/i,
  );
  if (recitalM) {
    const agreementType = recitalM[1].replace(/\s+/g, " ").trim();
    const baseDate = recitalM[2];
    return { ordinal, ordinalWord, baseDate, agreementType };
  }

  // Fallback (no recital anchor): the older NGS behavior. Agreement type from the
  // title "Amendment to … Agreement"; base date from the first "dated as of"
  // (which in NGS is the base, since the amendment's own date is phrased "dated
  // effective as of"). Preserves the existing null-return contract.
  const dateM = head.match(/dated as of\s+([A-Z][a-z]+\s+\d{1,2},\s+\d{4})/i);
  if (!dateM) return null;
  const baseDate = dateM[1];
  const typeM = head.match(/Amendment\s+to\s+(?:the\s+)?(?:that\s+certain\s+)?([A-Za-z][A-Za-z ]*?Agreement)\b/i);
  const agreementType = (typeM ? typeM[1] : "Agreement").replace(/\s+/g, " ").trim();
  return { ordinal, ordinalWord, baseDate, agreementType };
}
