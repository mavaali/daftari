// Local mirror of the Recall Bench day-metadata shape. The benchmark supplies
// this alongside each day's content; the adapter maps it onto daftari's
// builtin frontmatter (see corpus-map.ts).
export interface DayMetadata {
  dayNumber: number;
  date: string;
  personaId: string;
  activeArcs: string[];
}
